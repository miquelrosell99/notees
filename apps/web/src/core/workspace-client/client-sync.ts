/**
 * The sync-facing domain: the manual push/pull cycle, the realtime (WS)
 * acceleration channel, the engine status snapshot + semantic conflict
 * history for the sync UI, and applyRemoteBatch (realtime frames /
 * external injection through the engine).
 */

import type { Envelope } from "@notees/protocol";
import { summarizeEnvelopes } from "@notees/sync";

import {
  IDLE_SNAPSHOT,
  type ConflictHistoryEntry,
  type SyncStatusSnapshot,
} from "./types.js";
import { WorkspaceClientReadsRefs } from "./client-reads-refs.js";

export abstract class WorkspaceClientSync extends WorkspaceClientReadsRefs {
  /**
   * Push pending outbox ops now. Writes only kick a best-effort push; await
   * this when delivery must be deterministic (tests, "save & close"). The
   * engine's onPush/onPull callbacks notify with change-info — no wrapper
   * notify (an empty outbox changes nothing).
   */
  async push(): Promise<void> {
    await this.requireEngine().push();
  }

  /** Pull now: snapshot shortcut when newer, then seq catch-up. */
  async pull(): Promise<void> {
    await this.requireEngine().pull();
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
    const engine = this.requireEngine();
    this.stopRealtime();
    const stopChannel = engine.startRealtime();
    // Engine status transitions reach subscribers, but a status flip is not
    // data churn: notify with an explicitly empty change set so the read
    // cache invalidates nothing (the footer re-reads status on the same
    // notification).
    const stopStatus = engine.subscribeStatus(() =>
      this.notify({ affectedNodeIds: [], structural: false }),
    );
    this.realtimeStop = () => {
      stopStatus();
      stopChannel();
    };
    this.notify();
  }

  stopRealtime(): void {
    if (this.realtimeStop === null) return;
    this.realtimeStop();
    this.realtimeStop = null;
    this.notify();
  }

  isRealtimeActive(): boolean {
    return this.realtimeStop !== null;
  }

  // --- status snapshot (sync UI) ---------------------------------------------------------

  /** Recent semantic conflicts (newest last, bounded at CONFLICT_LOG_CAP). */
  conflictHistory(): ConflictHistoryEntry[] {
    return [...this.conflictLog];
  }

  /** Engine + outbox + realtime state for the footer status indicator. */
  status(): SyncStatusSnapshot {
    if (this.engine === null) return { ...IDLE_SNAPSHOT };
    const counts = this.engine.getOutboxCounts();
    return {
      status: this.engine.getStatus(),
      error: this.engine.getLastError()?.message ?? null,
      pending: counts.pending,
      failed: counts.failed,
      quarantined: counts.quarantined,
      parked: this.engine.getParkedCount(),
      realtime: this.isRealtimeActive(),
      cursorSeq: this.engine.getCursorSeq(),
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
    this.requireEngine().onRemoteBatch(envelopes, seqs ?? {});
    const info = summarizeEnvelopes(envelopes);
    // Remote envelopes may carry incomplete affected metadata; when we can
    // infer nothing, fall back to the scope-unknown notification (full
    // invalidation) rather than silently refreshing nothing.
    if (info.affectedNodeIds.length === 0 && !info.structural) this.notify();
    else this.notifyFromInfo(info);
  }
}
