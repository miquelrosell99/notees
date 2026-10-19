/**
 * The sync-facing domain: the SyncEngine bootstrap/lifecycle, the manual
 * push/pull cycle, the realtime (WS) acceleration channel, the engine status
 * snapshot + semantic conflict history for the sync UI, and
 * applyRemoteBatch (realtime frames / external injection through the
 * engine). Standalone domain — takes the shared ClientContext, no
 * inheritance.
 */

import { type Envelope } from "@notees/protocol";
import { SyncEngine, summarizeEnvelopes } from "@notees/sync";

import {
  CONFLICT_LOG_CAP,
  IDLE_SNAPSHOT,
  type ConflictHistoryEntry,
  type SyncStatusSnapshot,
} from "./types.js";
import type { ClientContext } from "./client-context.js";

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
    this.ctx.engine = new SyncEngine(this.ctx.store, this.ctx.transport, this.ctx.clock, {
      workspaceId,
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
        onPush: (_total, info) => this.ctx.notifyFromInfo(info),
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
    await this.ctx.engine.sync();
    // Bootstrap notifies unconditionally (the engine callbacks above also
    // fired): sync failures reject before the onPull callback runs, and the
    // initial UI seed must refresh either way.
    this.ctx.notify();
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
