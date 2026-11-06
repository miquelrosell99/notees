/**
 * The sync-facing domain: the SyncEngine bootstrap/lifecycle, the manual
 * push/pull cycle, the realtime (WS) acceleration channel, the engine status
 * snapshot + semantic conflict history for the sync UI, and
 * applyRemoteBatch (realtime frames / external injection through the
 * engine). Standalone domain — takes the shared ClientContext, no
 * inheritance.
 */

import { importWorkspaceKey, newEnvelope, type Envelope } from "@notees/protocol";
import { keyCryptoProvider } from "@notees/sync";
import { SyncEngine, summarizeEnvelopes, type EnvelopeCrypto } from "@notees/sync";
import { buildSystemSeedEnvelopes } from "@notees/domain";

import {
  RULES_ENGINE_CLIENT,
  WorkflowEvaluator,
  type WorkflowRuleView,
  type WorkflowRunRecord,
} from "../workflow-evaluator.js";
import {
  CONFLICT_LOG_CAP,
  IDLE_SNAPSHOT,
  type ConflictHistoryEntry,
  type SyncStatusSnapshot,
} from "./types.js";
import type { ClientContext } from "./client-context.js";

/** How long the workflow-rule listing is cached between applied batches. */
const RULES_CACHE_TTL_MS = 30_000;

export class WorkspaceClientSync {
  constructor(private readonly ctx: ClientContext) {}

  /**
   * Pull via the SyncEngine (snapshot shortcut when newer, then seq catch-up)
   * so local state converges with the relay. Any locally pending outbox ops
   * are pushed first (local-first, never lost).
   */
  async bootstrapWorkspace(workspaceId: string): Promise<void> {
    this.ctx.workspaceId = workspaceId;
    // A (re)bootstrap starts a fresh session journal: the durable unpushed
    // backlog replays below through the raw engine path on purpose (those
    // envelopes already had their session — re-journaling replays would mint
    // phantom undo entries).
    this.ctx.undoJournal.clear();
    // E2EE: with a workspace key the engine seals the wire (encrypt at push,
    // decrypt before apply) and seals/opens snapshots; keyless → plaintext
    // passthrough (keyless workspaces only — online keyed workspaces hold
    // their server-wrapped key since the fail-loud ruling, and offline
    // workspaces hold their device-local key since Task 9, so the keyed-
    // but-locked shape survives only as this runtime safety net).
    const crypto =
      this.ctx.workspaceKey !== null
        ? keyCryptoProvider(await importWorkspaceKey(this.ctx.workspaceKey))
        : undefined;
    this.ctx.engine = new SyncEngine(this.ctx.store, this.ctx.transport, this.ctx.clock, {
      workspaceId,
      ...(crypto !== undefined ? { crypto } : {}),
      callbacks: {
        onConflict: (conflicts) => {
          // Record before forwarding: the modal reads the log over RPC, and
          // conflicts are otherwise transient (emitted once, never stored).
          for (const conflict of conflicts) {
            this.ctx.conflictLog.push({ ...conflict, at: Date.now() });
          }
          if (this.ctx.conflictLog.length > CONFLICT_LOG_CAP) {
            this.ctx.conflictLog.splice(0, this.ctx.conflictLog.length - CONFLICT_LOG_CAP);
          }
          this.ctx.userOnConflict?.(conflicts);
        },
        onError: (error) => this.ctx.userOnSyncError?.(error),
        onSyncPhase: (phase, message) => this.ctx.userOnSyncPhase?.(phase, message),
        onPullProgress: (progress) => {
          if (progress === null) {
            // The engine's clearing signal — a zero total clears the bar upstream.
            this.ctx.userOnSyncProgress?.(0, 0);
            return;
          }
          this.ctx.userOnSyncProgress?.(progress.applied, progress.total);
        },
        // The workflow evaluator's hook (issue #13): evaluate every freshly
        // applied remote batch against the local store. Never blocks sync.
        onBatchApplied: (envelopes) => {
          const evaluator = this.ctx.workflowEvaluator;
          if (evaluator !== null) void evaluator.evaluate(envelopes).catch(() => {});
        },
        // Pushing does NOT change local state — the pushed envelopes applied
        // locally before they entered the outbox. Notifying here was pure
        // redundancy: it dirtied the whole read cache after every push
        // (and, with the read-delta stamps, would have re-served the class/
        // edge families on every push completion). Pulls and realtime frames
        // DO apply remote envelopes — those notify.
        onPull: (_total, info) => this.ctx.notifyFromInfo(info),
        // Realtime (WS) frames applied to the store refresh the UI exactly
        // like a pull does.
        onRemoteBatch: (_applied, info) => this.ctx.notifyFromInfo(info),
        // Durable local op log: locally-authored envelopes survive reloads
        // (the outbox is memory-only), and acknowledged envelopes are
        // cleared so the log holds only the unpushed backlog.
        onEnqueued: (envelope) => this.ctx.store.recordLocalEnvelope(envelope),
        onAcknowledged: (ids) => {
          this.ctx.store.markLocalEnvelopesPushed(ids);
          this.ctx.store.prunePushedLocalEnvelopes();
        },
      },
    });
    // The workflow-rules evaluator (issue #13): the client-side port of the
    // retired server probe — rules are coordination data (GET /api/workflows),
    // actions ride the client's own write path with the rules-engine claim,
    // and the run audit syncs to the server's coordination table.
    this.ctx.workflowEvaluator = new WorkflowEvaluator({
      workspaceId,
      database: this.ctx.store.database,
      rules: () => this.fetchWorkflowRules(),
      writeActions: async (envelopes) => {
        for (const envelope of envelopes) this.ctx.engine!.enqueue(envelope);
        await this.ctx.engine!.push();
        // Fresh action-envelope ids — the relay saves them (duplicates are
        // the client's own echoes, which the evaluator never re-fires on).
        return { savedIds: envelopes.map((envelope) => envelope.id) };
      },
      makeEnvelope: (input) =>
        newEnvelope({
          workspaceId,
          actorId: this.ctx.actorId,
          deviceId: this.ctx.deviceId,
          hlc: this.ctx.clock.now(),
          opType: input.opType,
          payload: input.payload,
          affectedNodeIds: input.affectedNodeIds,
          client: RULES_ENGINE_CLIENT,
          timestamp: new Date().toISOString(),
        }),
      recordRun: (run) => {
        this.postWorkflowRun(run);
      },
    });
    // Re-envelope the durable unpushed backlog (offline work from a previous
    // session): apply is idempotent by envelope id, so already-applied ops
    // are no-ops and the rest re-enter the outbox for the next push. Only
    // envelopes of THIS workspace re-enter — a backlog from another local
    // workspace never leaks across a workspace switch.
    for (const env of this.ctx.store.unpushedEnvelopes()) {
      if ((env as Envelope).workspaceId === workspaceId) {
        this.ctx.engine.enqueue(env as Envelope);
      }
    }
    // The sync cycle may reject (offline transport, unreachable relay). The
    // client-seed gate below must still run: a keyed OFFLINE workspace (Task
    // 9 — keyed at creation, device-local custody) has no server shim to
    // seed it, and its empty store would stay seedless forever. The gate is
    // empty-store-only, so a mid-sync snapshot restore still suppresses
    // reseeding; the error re-throws below exactly as before.
    let syncError: unknown = null;
    try {
      await this.ctx.engine.sync();
    } catch (error) {
      syncError = error;
    }
    // Client-side seeding of an EMPTY KEYED workspace: the server shim
    // deliberately skips keyed workspaces (they are client-seeded), so the
    // first keyed device stamps the system seeds itself — local-first via
    // enqueue, pushed sealed on the next cycle. Seed node ids are fixed
    // UUIDs: two devices seeding concurrently converge (create-on-existing
    // is a no-op; applied_envelope dedupes by envelope id). A keyless store
    // is the server shim's job; a non-empty store is never reseeded.
    if (crypto !== undefined && this.storeIsEmpty()) {
      const stamp = (opType: string, payload: Record<string, unknown>, affected?: string[]): Envelope =>
        newEnvelope({
          workspaceId,
          actorId: this.ctx.actorId,
          deviceId: this.ctx.deviceId,
          client: "seed",
          hlc: this.ctx.clock.now(),
          affectedNodeIds: affected ?? [],
          opType,
          payload,
          timestamp: new Date().toISOString(),
        });
      for (const envelope of buildSystemSeedEnvelopes(stamp)) {
        this.ctx.engine.enqueue(envelope);
      }
    }
    if (syncError !== null) throw syncError;
    // Bootstrap notifies unconditionally (the engine callbacks above also
    // fired): sync failures reject before the onPull callback runs, and the
    // initial UI seed must refresh either way.
    this.ctx.notify();
  }

  /** True when the derived store holds no node rows (the client-seed gate). */
  private storeIsEmpty(): boolean {
    const row = this.ctx.store.database.prepare("SELECT COUNT(*) AS n FROM node").get() as {
      n: number;
    };
    return row.n === 0;
  }

  private rulesCache: { at: number; rules: WorkflowRuleView[] } | null = null;

  /** The workspace's workflow rules (30 s cache — evaluation rides every applied batch). */
  private async fetchWorkflowRules(): Promise<WorkflowRuleView[]> {
    if (this.ctx.restServerUrl === null || this.ctx.restApiKey === null) return [];
    if (this.rulesCache !== null && Date.now() - this.rulesCache.at < RULES_CACHE_TTL_MS) {
      return this.rulesCache.rules;
    }
    const response = await fetch(`${this.ctx.restServerUrl}/api/workflows`, {
      headers: { "X-API-Key": this.ctx.restApiKey },
    });
    if (!response.ok) throw new Error(`workflow rules fetch failed: ${response.status}`);
    const body = (await response.json()) as {
      rules?: Array<{
        id: string;
        name: string;
        enabled: boolean;
        trigger: { opType: WorkflowRuleView["triggerOpType"] };
        criteria: unknown;
        actions: WorkflowRuleView["actions"];
      }>;
    };
    const rules = (body.rules ?? []).map((rule) => ({
      id: rule.id,
      name: rule.name,
      enabled: rule.enabled,
      triggerOpType: rule.trigger.opType,
      criteria: rule.criteria,
      actions: rule.actions,
    }));
    this.rulesCache = { at: Date.now(), rules };
    return rules;
  }

  /** The run audit rides to the server's coordination table (best-effort). */
  private postWorkflowRun(run: WorkflowRunRecord): void {
    if (this.ctx.restServerUrl === null || this.ctx.restApiKey === null) return;
    void fetch(`${this.ctx.restServerUrl}/api/workflows/${run.ruleId}/runs`, {
      method: "POST",
      headers: { "X-API-Key": this.ctx.restApiKey, "content-type": "application/json" },
      body: JSON.stringify({ runs: [run] }),
    }).catch(() => {
      // The local session buffer already holds the row.
    });
  }

  /**
   * One push+pull sync cycle against the relay. The engine's onPush/onPull/
   * status callbacks notify with change-info; no wrapper notify here (a
   * no-op cycle must not invalidate the read cache).
   */
  async sync(): Promise<void> {
    await this.ctx.requireEngine().sync();
  }

  /**
   * Push pending outbox ops now. Writes only kick a best-effort push; await
   * this when delivery must be deterministic (tests, "save & close"). The
   * engine's onPush/onPull callbacks notify with change-info — no wrapper
   * notify (an empty outbox changes nothing).
   */
  async push(): Promise<void> {
    await this.ctx.requireEngine().push();
  }

  /** Pull now: snapshot shortcut when newer, then seq catch-up. */
  async pull(): Promise<void> {
    await this.ctx.requireEngine().pull();
  }

  // --- realtime (WS acceleration path) ------------------------------------------------

  /**
   * Wire the transport's realtime channel: remote ops frames apply straight
   * to the store (buffered around pulls; the seq cursor remains
   * authoritative) and connection state changes notify subscribers so the UI
   * can refresh its status. Idempotent — restarts the channel when already
   * running.
   */
  startRealtime(): void {
    const engine = this.ctx.requireEngine();
    this.stopRealtime();
    const stopChannel = engine.startRealtime();
    // Engine status transitions reach subscribers, but a status flip is not
    // data churn: notify with an explicitly empty change set so the read
    // cache invalidates nothing (the footer re-reads status on the same
    // notification).
    const stopStatus = engine.subscribeStatus(() =>
      this.ctx.notify({ affectedNodeIds: [], structural: false }),
    );
    this.ctx.realtimeStop = () => {
      stopStatus();
      stopChannel();
    };
    this.ctx.notify();
  }

  stopRealtime(): void {
    if (this.ctx.realtimeStop === null) return;
    this.ctx.realtimeStop();
    this.ctx.realtimeStop = null;
    this.ctx.notify();
  }

  isRealtimeActive(): boolean {
    return this.ctx.realtimeStop !== null;
  }

  // --- status snapshot (sync UI) ---------------------------------------------------------

  /** Recent semantic conflicts (newest last, bounded at CONFLICT_LOG_CAP). */
  conflictHistory(): ConflictHistoryEntry[] {
    return [...this.ctx.conflictLog];
  }

  /** Engine + outbox + realtime state for the footer status indicator. */
  status(): SyncStatusSnapshot {
    if (this.ctx.engine === null) return { ...IDLE_SNAPSHOT };
    const counts = this.ctx.engine.getOutboxCounts();
    return {
      status: this.ctx.engine.getStatus(),
      error: this.ctx.engine.getLastError()?.message ?? null,
      pending: counts.pending,
      failed: counts.failed,
      quarantined: counts.quarantined,
      parked: this.ctx.engine.getParkedCount(),
      realtime: this.isRealtimeActive(),
      cursorSeq: this.ctx.engine.getCursorSeq(),
    };
  }

  /**
   * Apply a batch of remote envelopes (realtime frames / external injection)
   * through the engine: one store transaction, conflict detection against
   * local pending ops, HLC merge. Unknown seqs (null) keep the cursor; the
   * next pull re-fetches anything the batch covered. The notification carries
   * the batch's own change-info (the engine's onRemoteBatch callback fires
   * from inside onRemoteBatch only when no pull defers it — this wrapper
   * notify also covers the deferred and zero-applied paths).
   */
  applyRemoteBatch(envelopes: Envelope[], seqs?: Record<string, number> | null): void {
    this.ctx.requireEngine().onRemoteBatch(envelopes, seqs ?? {});
    const info = summarizeEnvelopes(envelopes);
    // Remote envelopes may carry incomplete affected metadata; when we can
    // infer nothing, fall back to the scope-unknown notification (full
    // invalidation) rather than silently refreshing nothing.
    if (info.affectedNodeIds.length === 0 && !info.structural) this.ctx.notify();
    else this.ctx.notifyFromInfo(info);
  }
}
