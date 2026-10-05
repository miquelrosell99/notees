/**
 * Workflow rules (issue #13) — "when X happens to nodes that fall into Y
 * criteria, do Z", evaluated server-side after every ingest.
 *
 * THE COORDINATION-STATE RULING (the prefs/shares/plugins precedent): rule
 * definitions and the run audit are server state in relay.db — NOT operation
 * log state. Rule *effects* are ordinary envelopes written by a server actor
 * (client claim "rules-engine") through the one write path, so every derived
 * store converges on them and no op type, wire change, or client lockstep is
 * involved. The only log entries a workflow ever produces are the action
 * envelopes themselves (property.set / the class-assign carrier).
 *
 * X (trigger) — existing op types: object.create, property.set, plus the
 * semantic "class.assign". There is NO class.assign op on the wire: class
 * membership add-wins rides a re-issued object.create carrying classIds
 * (op-catalog.ts), so the semantic trigger matches exactly those envelopes.
 *
 * Y (criteria) — the QueryAST (packages/protocol query-ast.ts), compiled by
 * @notees/query against the workspace's derived store and probed for the
 * envelope's affected node. Criteria are pure node filters: an AST carrying
 * an aggregation is rejected at rule creation.
 *
 * Z (actions, v1) — property.set and class.assign, each translated to its
 * EXISTING wire op at execution time (class.assign → object.create re-issue
 * with classIds, the OR-Set add carrier). New actions ride new trigger sets;
 * none of it changes the wire.
 *
 * LOOP POLICY (the correctness crux): action envelopes are written through a
 * re-entrant, depth-capped ingest. Max depth 1 — a client batch (depth 0) may
 * fire rules, whose actions ingest at depth 1 and are evaluated once more,
 * but matches at depth 1 write NOTHING (outcome "skipped_depth_cap"): rule
 * chains beyond one hop do not execute in v1. Within that one re-entry, the
 * loop breaker applies: a rule never fires on envelopes it caused
 * (outcome "skipped_loop" when it matches anyway). A firing whose action
 * ingest throws is recorded as "actions_failed" and never blocks the
 * triggering ingest.
 *
 * Evaluation is batched per ingest: envelopes are bucketed by op type so a
 * rule only sees envelopes that can trigger it, and each rule's criteria are
 * compiled once per evaluation. Engine ingests do NOT charge the client relay
 * rate budget (server-authored ops, the seed precedent) but DO broadcast, so
 * clients converge on rule effects immediately.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import { z } from "zod";
import { uuidv7 } from "uuidv7";

import {
  parseQueryAst,
  payloadSchemaFor,
  type Envelope,
  type QueryAst,
} from "@notees/protocol";
import { compile, type CompiledQuery } from "@notees/query";

import type { EnvelopeFactory } from "./envelope-factory.js";

// --- vocabulary & caps ----------------------------------------------------------

/**
 * X triggers, v1. "class.assign" is the semantic name for the wire's
 * object-create OR-Set add carrier (see module header); the other two are
 * literal op types.
 */
export const WORKFLOW_TRIGGER_OP_TYPES = ["object.create", "property.set", "class.assign"] as const;
export type WorkflowTriggerOpType = (typeof WORKFLOW_TRIGGER_OP_TYPES)[number];

/** Actions per rule — a firing writes at most this many envelopes per node. */
export const MAX_WORKFLOW_ACTIONS = 10;
/** Rules per workspace — keeps a bulk ingest's evaluation bounded. */
export const MAX_WORKFLOW_RULES_PER_WORKSPACE = 100;
/** Re-entrant ingest cap: client ingest = depth 0, rule actions = depth 1. */
export const WORKFLOW_MAX_DEPTH = 1;
/** The actor client claim stamped on every rule-action envelope. */
export const RULES_ENGINE_CLIENT = "rules-engine";
/** Default page size for the run-audit listing. */
export const WORKFLOW_RUNS_PAGE = 200;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// --- actions --------------------------------------------------------------------

export const workflowActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("property.set"),
      propertySchemaId: z.string().uuid(),
      value: z.unknown(),
      idx: z.number().int().nonnegative().default(0),
    })
    .strict(),
  z
    .object({
      type: z.literal("class.assign"),
      classId: z.string().uuid(),
    })
    .strict(),
]);

/** A validated workflow action (the zod inference — a property.set value may be any JSON, or absent). */
export type WorkflowAction = z.infer<typeof workflowActionSchema>;

/** The EXISTING wire op each action translates to (no new op type — issue #13). */
export function actionOpType(action: WorkflowAction): string {
  return action.type === "class.assign" ? "object.create" : "property.set";
}

/**
 * The wire payload for an action aimed at `nodeId`. class.assign is the
 * re-issued object.create carrying classIds — the OR-Set add carrier that
 * seeds membership without touching the tree (op-catalog.ts).
 */
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

// --- rule bodies ----------------------------------------------------------------

const triggerSchema = z
  .object({ opType: z.enum(WORKFLOW_TRIGGER_OP_TYPES) })
  .strict();

export const workflowRuleCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    enabled: z.boolean().optional(),
    trigger: triggerSchema,
    criteria: z.unknown(),
    actions: z.array(workflowActionSchema).min(1).max(MAX_WORKFLOW_ACTIONS),
  })
  .strict();

export const workflowRulePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    enabled: z.boolean().optional(),
    trigger: triggerSchema.optional(),
    criteria: z.unknown().optional(),
    actions: z.array(workflowActionSchema).min(1).max(MAX_WORKFLOW_ACTIONS).optional(),
  })
  .strict()
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "at least one of name/enabled/trigger/criteria/actions is required",
  });

/**
 * Criteria validation, fail-loud at the API boundary (422, never stored
 * broken): strict QueryAST parse, no aggregation (criteria probe node
 * membership; a grouped report has no `id` column to probe), and a trial
 * compile so a placeholder/scope error surfaces now, not at trigger time.
 */
export function validateWorkflowCriteria(input: unknown): QueryAst {
  const ast = parseQueryAst(input);
  if (ast.aggregation !== undefined) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["criteria", "aggregation"],
        message: "workflow criteria must not carry an aggregation — it is a node filter, not a grouped report",
      },
    ]);
  }
  compile(ast); // trial compile — throws on unresolvable placeholders/scopes
  return ast;
}

/**
 * Action validation beyond the body schema: the composed payload must pass
 * the wire's own op schema, so a firing can never stamp an envelope the
 * store would reject as schema-invalid.
 */
export function validateWorkflowActions(actions: WorkflowAction[]): void {
  const probeNodeId = "00000000-0000-7000-8000-000000000000";
  for (const action of actions) {
    const schema = payloadSchemaFor(actionOpType(action));
    if (schema === undefined) continue;
    const parsed = schema.safeParse(actionPayload(action, probeNodeId));
    if (!parsed.success) {
      throw new z.ZodError(
        parsed.error.issues.map((issue) => ({
          ...issue,
          path: ["actions", action.type, ...issue.path],
        })),
      );
    }
  }
}

// --- rows ------------------------------------------------------------------------

export interface WorkflowRule {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  triggerOpType: WorkflowTriggerOpType;
  criteria: QueryAst;
  actions: WorkflowAction[];
  createdAt: number;
  updatedAt: number;
}

export type WorkflowRunOutcome =
  | "actions_written"
  | "actions_failed"
  | "skipped_loop"
  | "skipped_depth_cap";

export interface WorkflowRun {
  id: string;
  ruleId: string;
  workspaceId: string;
  triggerEnvelopeId: string;
  nodeId: string;
  /** The action envelopes actually persisted ({opType, envelopeId} per action). */
  actionsWritten: Array<{ opType: string; envelopeId: string }>;
  outcome: WorkflowRunOutcome;
  /** Failure message / skip reason — null on success. */
  detail: string | null;
  createdAt: number;
}

interface WorkflowRuleRaw {
  id: string;
  workspace_id: string;
  name: string;
  enabled: number;
  trigger_op_type: string;
  criteria: string;
  actions: string;
  created_at: number;
  updated_at: number;
}

interface WorkflowRunRaw {
  id: string;
  rule_id: string;
  workspace_id: string;
  trigger_envelope_id: string;
  node_id: string;
  actions_written: string;
  outcome: string;
  detail: string | null;
  created_at: number;
}

function toRule(raw: WorkflowRuleRaw): WorkflowRule {
  return {
    id: raw.id,
    workspaceId: raw.workspace_id,
    name: raw.name,
    enabled: raw.enabled === 1,
    triggerOpType: raw.trigger_op_type as WorkflowTriggerOpType,
    criteria: JSON.parse(raw.criteria) as QueryAst,
    actions: JSON.parse(raw.actions) as WorkflowAction[],
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

function toRun(raw: WorkflowRunRaw): WorkflowRun {
  return {
    id: raw.id,
    ruleId: raw.rule_id,
    workspaceId: raw.workspace_id,
    triggerEnvelopeId: raw.trigger_envelope_id,
    nodeId: raw.node_id,
    actionsWritten: JSON.parse(raw.actions_written) as WorkflowRun["actionsWritten"],
    outcome: raw.outcome as WorkflowRunOutcome,
    detail: raw.detail,
    createdAt: raw.created_at,
  };
}

// --- storage ----------------------------------------------------------------------

const DDL = `
CREATE TABLE IF NOT EXISTS workflow_rule (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    trigger_op_type TEXT NOT NULL,
    criteria TEXT NOT NULL,
    actions TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_rule_workspace ON workflow_rule (workspace_id, created_at, id);

CREATE TABLE IF NOT EXISTS workflow_run (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    trigger_envelope_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    actions_written TEXT NOT NULL,
    outcome TEXT NOT NULL,
    detail TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_run_rule ON workflow_run (rule_id, created_at);
`;

/** Rule definitions + the append-only run audit, on the shared relay.db. */
export class WorkflowStorage {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    // Additive migration: CREATE-IF-NOT-EXISTS on the shared relay.db.
    this.db.exec(DDL);
  }

  create(input: {
    workspaceId: string;
    name: string;
    enabled: boolean;
    triggerOpType: WorkflowTriggerOpType;
    criteria: QueryAst;
    actions: WorkflowAction[];
  }): WorkflowRule {
    const now = Date.now();
    const raw: WorkflowRuleRaw = {
      id: uuidv7(),
      workspace_id: input.workspaceId,
      name: input.name,
      enabled: input.enabled ? 1 : 0,
      trigger_op_type: input.triggerOpType,
      criteria: JSON.stringify(input.criteria),
      actions: JSON.stringify(input.actions),
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO workflow_rule
           (id, workspace_id, name, enabled, trigger_op_type, criteria, actions, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        raw.id,
        raw.workspace_id,
        raw.name,
        raw.enabled,
        raw.trigger_op_type,
        raw.criteria,
        raw.actions,
        raw.created_at,
        raw.updated_at,
      );
    return toRule(raw);
  }

  list(workspaceId: string): WorkflowRule[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM workflow_rule WHERE workspace_id = ? ORDER BY created_at, id",
      )
      .all(workspaceId) as unknown as WorkflowRuleRaw[];
    return rows.map(toRule);
  }

  count(workspaceId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM workflow_rule WHERE workspace_id = ?")
      .get(workspaceId) as { n: number };
    return row.n;
  }

  find(workspaceId: string, id: string): WorkflowRule | null {
    const row = this.db
      .prepare("SELECT * FROM workflow_rule WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, id) as WorkflowRuleRaw | undefined;
    return row === undefined ? null : toRule(row);
  }

  update(
    workspaceId: string,
    id: string,
    patch: {
      name?: string;
      enabled?: boolean;
      triggerOpType?: WorkflowTriggerOpType;
      criteria?: QueryAst;
      actions?: WorkflowAction[];
    },
  ): WorkflowRule | null {
    const existing = this.find(workspaceId, id);
    if (existing === null) return null;
    const next: WorkflowRule = {
      ...existing,
      name: patch.name ?? existing.name,
      enabled: patch.enabled ?? existing.enabled,
      triggerOpType: patch.triggerOpType ?? existing.triggerOpType,
      criteria: patch.criteria ?? existing.criteria,
      actions: patch.actions ?? existing.actions,
      updatedAt: Date.now(),
    };
    this.db
      .prepare(
        `UPDATE workflow_rule
         SET name = ?, enabled = ?, trigger_op_type = ?, criteria = ?, actions = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(
        next.name,
        next.enabled ? 1 : 0,
        next.triggerOpType,
        JSON.stringify(next.criteria),
        JSON.stringify(next.actions),
        next.updatedAt,
        workspaceId,
        id,
      );
    return next;
  }

  remove(workspaceId: string, id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM workflow_rule WHERE workspace_id = ? AND id = ?")
      .run(workspaceId, id);
    return result.changes > 0;
  }

  /** The evaluation input: enabled rules, deterministic order, criteria compiled by the caller. */
  enabledRules(workspaceId: string): WorkflowRule[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM workflow_rule WHERE workspace_id = ? AND enabled = 1 ORDER BY created_at, id",
      )
      .all(workspaceId) as unknown as WorkflowRuleRaw[];
    return rows.map(toRule);
  }

  /** Append-only audit — one row per (rule, trigger envelope, matched node) firing attempt. */
  recordRun(input: {
    ruleId: string;
    workspaceId: string;
    triggerEnvelopeId: string;
    nodeId: string;
    actionsWritten: WorkflowRun["actionsWritten"];
    outcome: WorkflowRunOutcome;
    detail: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO workflow_run
           (id, rule_id, workspace_id, trigger_envelope_id, node_id, actions_written, outcome, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        uuidv7(),
        input.ruleId,
        input.workspaceId,
        input.triggerEnvelopeId,
        input.nodeId,
        JSON.stringify(input.actionsWritten),
        input.outcome,
        input.detail,
        Date.now(),
      );
  }

  runs(workspaceId: string, ruleId: string, limit = WORKFLOW_RUNS_PAGE): WorkflowRun[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM workflow_run WHERE workspace_id = ? AND rule_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .all(workspaceId, ruleId, limit) as unknown as WorkflowRunRaw[];
    return rows.map(toRun);
  }

  close(): void {
    this.db.close();
  }
}

// --- engine ------------------------------------------------------------------------

/** The re-entrancy context threaded through the capped ingest. */
export interface WorkflowEvaluationContext {
  /** 0 = client-authorized ingest; ≥1 = rules-engine action ingest. */
  depth: number;
  /** Rule ids already fired on this causal chain — the loop breaker set. */
  firedRuleIds: ReadonlySet<string>;
}

export interface WorkflowEngineDeps {
  /** The workspace's derived store (read side of the criteria probe). */
  storeFor(workspaceId: string): {
    database: { prepare(sql: string): { get(...params: unknown[]): unknown } };
  };
  factory: EnvelopeFactory;
  /** The re-entrant, depth-capped ingest (full pipeline: log → apply → broadcast → evaluate). */
  ingest(
    envelopes: Envelope[],
    ctx: WorkflowEvaluationContext,
  ): Promise<{ savedIds: string[] }>;
}

/**
 * Does this envelope trip the rule's trigger? "class.assign" is the semantic
 * name for the wire carrier: an object.create re-issue carrying classIds.
 */
export function triggerMatches(triggerOpType: WorkflowTriggerOpType, env: Envelope): boolean {
  if (env.opType === triggerOpType) return true;
  if (triggerOpType !== "class.assign" || env.opType !== "object.create") return false;
  const classIds = (env.payload as { classIds?: unknown }).classIds;
  return Array.isArray(classIds) && classIds.length > 0;
}

/**
 * The nodes a trigger envelope could plausibly affect: its declared affected
 * set plus the payload's object/class ids (payload-derived, so a client that
 * left affectedNodeIds empty still trips rules). The criteria probe decides.
 */
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

export class WorkflowEngine {
  constructor(
    private readonly storage: WorkflowStorage,
    private readonly deps: WorkflowEngineDeps,
  ) {}

  /**
   * Post-ingest evaluation: for each saved envelope that trips an enabled
   * rule's trigger, probe the rule's criteria against the envelope's
   * affected nodes in the (already-updated) derived store; on a match, fire.
   * Never throws — a rule failure is an audit row, not an ingest failure.
   */
  async evaluate(
    workspaceId: string,
    saved: Envelope[],
    ctx: WorkflowEvaluationContext,
  ): Promise<void> {
    if (ctx.depth > WORKFLOW_MAX_DEPTH) return; // defensive: depth-1 firings never write, so this is unreachable
    const rules = this.storage.enabledRules(workspaceId);
    if (rules.length === 0 || saved.length === 0) return;
    // Compile each rule's criteria once per evaluation (not per envelope).
    const compiled: Array<{ rule: WorkflowRule; query: CompiledQuery }> = [];
    for (const rule of rules) {
      try {
        compiled.push({ rule, query: compile(rule.criteria) });
      } catch (error) {
        // Creation-time validation should make this unreachable; a broken
        // stored rule skips rather than poisoning every ingest.
        console.error(`[workflows] rule ${rule.id} failed to compile; skipped`, error);
      }
    }
    const store = this.deps.storeFor(workspaceId);
    for (const env of saved) {
      for (const { rule, query } of compiled) {
        if (!triggerMatches(rule.triggerOpType, env)) continue;
        for (const nodeId of affectedNodeCandidates(env)) {
          const matched =
            store.database
              .prepare(`SELECT 1 FROM (${query.sql}) q WHERE q.id = ?`)
              .get(...query.params, nodeId) !== undefined;
          if (matched) await this.fire(workspaceId, rule, env, nodeId, ctx);
        }
      }
    }
  }

  private async fire(
    workspaceId: string,
    rule: WorkflowRule,
    env: Envelope,
    nodeId: string,
    ctx: WorkflowEvaluationContext,
  ): Promise<void> {
    if (ctx.firedRuleIds.has(rule.id)) {
      this.storage.recordRun({
        ruleId: rule.id,
        workspaceId,
        triggerEnvelopeId: env.id,
        nodeId,
        actionsWritten: [],
        outcome: "skipped_loop",
        detail: "the rule already fired on this causal chain — engine envelopes never re-trigger the same rule",
      });
      return;
    }
    if (ctx.depth >= WORKFLOW_MAX_DEPTH) {
      this.storage.recordRun({
        ruleId: rule.id,
        workspaceId,
        triggerEnvelopeId: env.id,
        nodeId,
        actionsWritten: [],
        outcome: "skipped_depth_cap",
        detail: `rule chains beyond depth ${WORKFLOW_MAX_DEPTH} do not execute in v1`,
      });
      return;
    }
    const envelopes = rule.actions.map((action) =>
      this.deps.factory.make({
        workspaceId,
        opType: actionOpType(action),
        payload: actionPayload(action, nodeId),
        affectedNodeIds: [nodeId],
        client: RULES_ENGINE_CLIENT,
      }),
    );
    try {
      const outcome = await this.deps.ingest(envelopes, {
        depth: ctx.depth + 1,
        firedRuleIds: new Set([...ctx.firedRuleIds, rule.id]),
      });
      const saved = new Set(outcome.savedIds);
      this.storage.recordRun({
        ruleId: rule.id,
        workspaceId,
        triggerEnvelopeId: env.id,
        nodeId,
        actionsWritten: envelopes
          .filter((envelope) => saved.has(envelope.id))
          .map((envelope) => ({ opType: envelope.opType, envelopeId: envelope.id })),
        outcome: "actions_written",
        detail: null,
      });
    } catch (error) {
      this.storage.recordRun({
        ruleId: rule.id,
        workspaceId,
        triggerEnvelopeId: env.id,
        nodeId,
        actionsWritten: [],
        outcome: "actions_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
