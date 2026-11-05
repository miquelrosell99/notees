/**
 * WorkflowEvaluator — the client-side port of the retired server probe
 * (plan-07 recorded debt; issue #13): "when X happens to nodes that fall into
 * Y criteria, do Z", evaluated on every freshly-applied remote envelope
 * batch, against the LOCAL derived store.
 *
 * Semantics ported verbatim from the retired WorkflowEngine
 * (git 7ca44bed2^ apps/server/src/workflows.ts):
 *
 * - X (trigger): object.create / property.set / "class.assign" (the semantic
 *   name for the wire's object-create OR-Set add carrier — an object.create
 *   carrying classIds).
 * - Y (criteria): the QueryAST compiled by @notees/query and probed per
 *   affected-node candidate: SELECT 1 FROM (<compiled>) q WHERE q.id = ?.
 * - Z (actions): property.set and class.assign, translated to their EXISTING
 *   wire ops, written through the client's own write path with the
 *   "rules-engine" client claim — every derived store converges on them.
 * - LOOP POLICY: the depth cap is 1 — client batches are depth 0; envelopes
 *   stamped by the rules-engine claim (the sync echo of an action) are depth
 *   1. The causal chain (which rules fired upstream of an envelope) rides a
 *   map keyed by the action envelope ids, mirroring the retired engine's
 *   `firedRuleIds` threading through the re-entrant ingest: a depth-1 match
 *   on a rule IN the chain records "skipped_loop"; on a rule OUTSIDE it
 *   records "skipped_depth_cap"; neither writes anything.
 * - Failures are audit rows ("actions_failed"), never batch failures.
 *
 * Evaluation runs per DEVICE (the server no longer evaluates): every device
 * seeing the echo writes its own action envelopes — identical payloads that
 * converge idempotently (LWW same value / OR-Set add-wins), with one audit
 * row per device. The run audit syncs to the server's coordination table via
 * POST /api/workflows/:id/runs; a session ring buffer keeps it readable
 * locally too.
 */

import type { Envelope } from "@notees/protocol";
import { compile, type CompiledQuery } from "@notees/query";

export const WORKFLOW_TRIGGER_OP_TYPES = ["object.create", "property.set", "class.assign"] as const;
export type WorkflowTriggerOpType = (typeof WORKFLOW_TRIGGER_OP_TYPES)[number];

/** The actor client claim stamped on every rule-action envelope. */
export const RULES_ENGINE_CLIENT = "rules-engine";
/** Re-entrant ingest cap: client batches = depth 0, rule-action echoes = depth 1. */
export const WORKFLOW_MAX_DEPTH = 1;

export type WorkflowRunOutcome =
  | "actions_written"
  | "actions_failed"
  | "skipped_loop"
  | "skipped_depth_cap";

export type WorkflowAction =
  | { type: "property.set"; propertySchemaId: string; value?: unknown; idx: number }
  | { type: "class.assign"; classId: string };

export interface WorkflowRuleView {
  id: string;
  name: string;
  enabled: boolean;
  triggerOpType: WorkflowTriggerOpType;
  criteria: unknown;
  actions: WorkflowAction[];
}

export interface WorkflowRunRecord {
  ruleId: string;
  workspaceId: string;
  triggerEnvelopeId: string;
  nodeId: string;
  actionsWritten: Array<{ opType: string; envelopeId: string }>;
  outcome: WorkflowRunOutcome;
  detail: string | null;
}

export interface WorkflowEvaluatorDeps {
  workspaceId: string;
  /** The local derived store's database (the criteria probe's read side). */
  database: { prepare(sql: string): { get(...params: unknown[]): unknown } };
  /** The workspace's enabled rules (GET /api/workflows). */
  rules: () => Promise<WorkflowRuleView[]>;
  /** Write rule-action envelopes through the client write path (enqueue + push). */
  writeActions: (envelopes: Envelope[]) => Promise<{ savedIds: string[] }>;
  makeEnvelope: (input: {
    opType: string;
    payload: Record<string, unknown>;
    affectedNodeIds: string[];
  }) => Envelope;
  /** Record a run: the local session buffer + the coordination sync. */
  recordRun: (run: WorkflowRunRecord) => void;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The EXISTING wire op each action translates to (no new op type). */
export function actionOpType(action: WorkflowAction): string {
  return action.type === "class.assign" ? "object.create" : "property.set";
}

/** The wire payload for an action aimed at `nodeId`. */
export function actionPayload(action: WorkflowAction, nodeId: string): Record<string, unknown> {
  switch (action.type) {
    case "property.set":
      return {
        objectId: nodeId,
        propertySchemaId: action.propertySchemaId,
        value: action.value ?? null,
        idx: action.idx,
      };
    case "class.assign":
      return { objectId: nodeId, classIds: [action.classId] };
  }
}

/** Does this envelope trip the rule's trigger? (class.assign = the carrier.) */
export function triggerMatches(triggerOpType: WorkflowTriggerOpType, env: Envelope): boolean {
  if (env.opType === triggerOpType) return true;
  if (triggerOpType !== "class.assign" || env.opType !== "object.create") return false;
  const classIds = (env.payload as { classIds?: unknown }).classIds;
  return Array.isArray(classIds) && classIds.length > 0;
}

/** The nodes a trigger envelope could plausibly affect (payload-derived too). */
export function affectedNodeCandidates(env: Envelope): string[] {
  const ids = new Set<string>();
  for (const id of env.affectedNodeIds) {
    if (typeof id === "string" && UUID_RE.test(id)) ids.add(id);
  }
  const payload = env.payload as Record<string, unknown>;
  for (const key of ["objectId", "classId"] as const) {
    const value = payload[key];
    if (typeof value === "string" && UUID_RE.test(value)) ids.add(value);
  }
  return [...ids];
}

/** Session ring buffer of run records (the local read; the server table is durable). */
const RUN_BUFFER_CAP = 200;

export class WorkflowEvaluator {
  private readonly runs: WorkflowRunRecord[] = [];
  /** Action-envelope id → the causal chain it inherits (the retired firedRuleIds threading). */
  private readonly causedChains = new Map<string, ReadonlySet<string>>();

  constructor(private readonly deps: WorkflowEvaluatorDeps) {}

  /** The session's run records (newest last). */
  runLog(): readonly WorkflowRunRecord[] {
    return this.runs;
  }

  /**
   * Post-apply evaluation: for each envelope that trips an enabled rule's
   * trigger, probe the criteria against the affected candidates in the
   * (already-updated) local store; on a match, fire. Never throws.
   */
  async evaluate(batch: Envelope[]): Promise<void> {
    let rules: WorkflowRuleView[];
    try {
      rules = (await this.deps.rules()).filter((rule) => rule.enabled);
    } catch {
      return; // Rules unreadable — evaluation is best-effort, sync is not blocked.
    }
    if (rules.length === 0 || batch.length === 0) return;
    const compiled: Array<{ rule: WorkflowRuleView; query: CompiledQuery }> = [];
    for (const rule of rules) {
      try {
        compiled.push({ rule, query: compile(rule.criteria as never) });
      } catch (error) {
        // Creation-time validation should make this unreachable; a broken
        // rule skips rather than poisoning every batch (retired parity).
        console.error(`[workflows] rule ${rule.id} failed to compile; skipped`, error);
      }
    }
    // The batch-level chain accumulates across this call's firings, exactly
    // like the retired engine's ctx across one ingest evaluation.
    const batchChain = new Set<string>();
    for (const env of batch) {
      const inherited = this.causedChains.get(env.id);
      this.causedChains.delete(env.id);
      const depth = env.client === RULES_ENGINE_CLIENT ? 1 : 0;
      for (const { rule, query } of compiled) {
        if (!triggerMatches(rule.triggerOpType, env)) continue;
        for (const nodeId of affectedNodeCandidates(env)) {
          let matched = false;
          try {
            matched =
              this.deps.database
                .prepare(`SELECT 1 FROM (${query.sql}) q WHERE q.id = ?`)
                .get(...query.params, nodeId) !== undefined;
          } catch {
            matched = false; // A broken probe is a miss, never a batch failure.
          }
          if (!matched) continue;
          const fired = await this.fire(rule, env, nodeId, depth, inherited ?? new Set(), batchChain);
          if (fired) batchChain.add(rule.id);
        }
      }
    }
  }

  private async fire(
    rule: WorkflowRuleView,
    env: Envelope,
    nodeId: string,
    depth: number,
    inherited: ReadonlySet<string>,
    batchChain: Set<string>,
  ): Promise<boolean> {
    const chain = new Set([...inherited, ...batchChain]);
    if (chain.has(rule.id)) {
      this.record({
        ruleId: rule.id,
        workspaceId: this.deps.workspaceId,
        triggerEnvelopeId: env.id,
        nodeId,
        actionsWritten: [],
        outcome: "skipped_loop",
        detail: "the rule already fired on this causal chain — engine envelopes never re-trigger the same rule",
      });
      return false;
    }
    if (depth >= WORKFLOW_MAX_DEPTH) {
      this.record({
        ruleId: rule.id,
        workspaceId: this.deps.workspaceId,
        triggerEnvelopeId: env.id,
        nodeId,
        actionsWritten: [],
        outcome: "skipped_depth_cap",
        detail: `rule chains beyond depth ${WORKFLOW_MAX_DEPTH} do not execute`,
      });
      return false;
    }
    const envelopes = rule.actions.map((action) =>
      this.deps.makeEnvelope({
        opType: actionOpType(action),
        payload: actionPayload(action, nodeId),
        affectedNodeIds: [nodeId],
      }),
    );
    const nextChain = new Set([...chain, rule.id]);
    for (const envelope of envelopes) this.causedChains.set(envelope.id, nextChain);
    try {
      const outcome = await this.deps.writeActions(envelopes);
      const saved = new Set(outcome.savedIds);
      this.record({
        ruleId: rule.id,
        workspaceId: this.deps.workspaceId,
        triggerEnvelopeId: env.id,
        nodeId,
        actionsWritten: envelopes
          .filter((envelope) => saved.has(envelope.id))
          .map((envelope) => ({ opType: envelope.opType, envelopeId: envelope.id })),
        outcome: "actions_written",
        detail: null,
      });
      return true;
    } catch (error) {
      this.record({
        ruleId: rule.id,
        workspaceId: this.deps.workspaceId,
        triggerEnvelopeId: env.id,
        nodeId,
        actionsWritten: [],
        outcome: "actions_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private record(run: WorkflowRunRecord): void {
    this.runs.push(run);
    if (this.runs.length > RUN_BUFFER_CAP) this.runs.splice(0, this.runs.length - RUN_BUFFER_CAP);
    try {
      this.deps.recordRun(run);
    } catch {
      // The coordination sync is best-effort; the local buffer already holds it.
    }
  }
}
