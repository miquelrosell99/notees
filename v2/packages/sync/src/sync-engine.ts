/**
 * SyncEngine: the v2 client/server sync engine — outbox push, seq-cursor
 * catch-up pull, snapshot shortcut, restoreEpoch wipe+park recovery, realtime
 * acceleration hook, and conflict reporting. Port of v1
 * `frontend/src/core/sync.ts` (968-line SyncEngine) adapted to WIRE.md:
 *  - seq is the only ordering authority (no HLC catch-up; HLC remains the LWW
 *    causality watermark for snapshot decisions);
 *  - envelopes are validated/applied through @notees/store (applied_envelope
 *    idempotency, one transaction per page via applyMany);
 *  - the server seq cursor persists in app_meta (see meta.ts for why not
 *    sync_state.cursor_seq);
 *  - single-user M1: no E2EE decryption, no presence; the WS acceleration
 *    path is wired through Transport.subscribe (HttpTransport implements it).
 */

import {
  compareHlc,
  maxHlc,
  type Clock,
  type Envelope,
  type Hlc,
} from "@notees/protocol";
import { validateEnvelope, type ChangeSummary, type Store } from "@notees/store";

import { detectConflicts, type SyncConflict } from "./conflicts.js";
import { SyncMeta } from "./meta.js";
import { Outbox } from "./outbox.js";
import type {
  OutboxStatusCounts,
  SnapshotMeta,
  SyncEngineCallbacks,
  SyncPushProgress,
  SyncStatus,
  Transport,
} from "./types.js";

/** v1 backoff schedule: 5s, 15s, 1m, 5m, 30m; exhausted → quarantined. */
const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000, 1_800_000] as const;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_CATCH_UP_LIMIT = 1000;
const ZERO_HLC: Hlc = { physical: 0, logical: 0 };

export interface SyncEngineOptions {
  /** Workspace this engine syncs; keys the persisted watermarks. */
  workspaceId?: string;
  /** Wall clock (ms epoch) for backoff scheduling; defaults to Date.now. */
  now?: () => number;
  /** Push chunk size (WIRE.md caps batches at 1000). */
  batchSize?: number;
  /** Catch-up page size. */
  catchUpLimit?: number;
  callbacks?: SyncEngineCallbacks;
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export class SyncEngine {
  private readonly store: Store;
  private readonly transport: Transport;
  private readonly clock: Clock;
  private readonly outbox = new Outbox();
  private readonly meta: SyncMeta;
  private readonly workspaceId: string;
  private readonly now: () => number;
  private readonly batchSize: number;
  private readonly catchUpLimit: number;
  private callbacks: SyncEngineCallbacks;

  private cursorSeq: number;
  private receivedHlc: Hlc;
  private restoreEpoch: number;
  private status: SyncStatus = "idle";
  private lastError: Error | null = null;
  /** HLC of the last snapshot this session uploaded; avoids re-uploading. */
  private uploadedSnapshotHlc: Hlc | null = null;
  private inFlightSync: Promise<void> | null = null;
  private pullInFlight = false;
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;

  private readonly statusListeners = new Set<
    (status: SyncStatus, error: Error | null) => void
  >();
  private readonly conflictListeners = new Set<(conflicts: SyncConflict[]) => void>();
  private wsBuffer: Array<{ envelopes: Envelope[]; seqs: Record<string, number> }> = [];
  private unsubscribeRealtime: (() => void) | null = null;

  constructor(store: Store, transport: Transport, clock: Clock, options: SyncEngineOptions = {}) {
    this.store = store;
    this.transport = transport;
    this.clock = clock;
    this.workspaceId = options.workspaceId ?? "00000000-0000-0000-0000-000000000000";
    this.now = options.now ?? (() => Date.now());
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.catchUpLimit = options.catchUpLimit ?? DEFAULT_CATCH_UP_LIMIT;
    this.callbacks = options.callbacks ?? {};
    this.meta = new SyncMeta(store, `sync:${this.workspaceId}:state`);
    const persisted = this.meta.load();
    this.cursorSeq = persisted?.cursorSeq ?? 0;
    this.receivedHlc = persisted?.receivedHlc ?? ZERO_HLC;
    this.restoreEpoch = persisted?.restoreEpoch ?? 0;
  }

  // --- status & subscriptions ---------------------------------------------------

  getStatus(): SyncStatus {
    return this.status;
  }

  getLastError(): Error | null {
    return this.lastError;
  }

  getCursorSeq(): number {
    return this.cursorSeq;
  }

  getRestoreEpoch(): number {
    return this.restoreEpoch;
  }

  getOutboxCounts(): OutboxStatusCounts {
    return this.outbox.counts();
  }

  getParkedCount(): number {
    return this.outbox.parkedCount();
  }

  setCallbacks(callbacks: SyncEngineCallbacks): void {
    this.callbacks = callbacks;
  }

  subscribeStatus(callback: (status: SyncStatus, error: Error | null) => void): () => void {
    callback(this.status, this.lastError);
    this.statusListeners.add(callback);
    return () => this.statusListeners.delete(callback);
  }

  subscribeConflicts(callback: (conflicts: SyncConflict[]) => void): () => void {
    this.conflictListeners.add(callback);
    return () => this.conflictListeners.delete(callback);
  }

  private setStatus(status: SyncStatus, error: Error | null = null): void {
    this.status = status;
    this.lastError = error;
    this.callbacks.onStatusChange?.(status, error);
    for (const listener of this.statusListeners) listener(status, error);
  }

  private emitConflicts(conflicts: SyncConflict[]): void {
    if (conflicts.length === 0) return;
    this.callbacks.onConflict?.(conflicts);
    for (const listener of this.conflictListeners) listener(conflicts);
  }

  private reportPhase(phase: string, message: string): void {
    this.callbacks.onSyncPhase?.(phase, message);
  }

  private reportOutboxCounts(): void {
    this.callbacks.onOutboxCounts?.(this.outbox.counts());
  }

  private persistState(): void {
    this.meta.save({
      cursorSeq: this.cursorSeq,
      receivedHlc: this.receivedHlc,
      restoreEpoch: this.restoreEpoch,
    });
  }

  // --- outbox ----------------------------------------------------------------------

  /**
   * Commit a local envelope: applied to the store immediately (local-first)
   * and tracked in the outbox as pending until the server acknowledges it.
   */
  enqueue(envelope: Envelope): ChangeSummary {
    const summary = this.store.apply(envelope);
    this.outbox.add(envelope);
    return summary;
  }

  /** Requeue quarantined ops and push them (v1 retryQuarantined). */
  async requeueQuarantined(): Promise<void> {
    this.outbox.requeueQuarantined();
    this.reportOutboxCounts();
    await this.syncOnce();
  }

  /** Re-push ops parked by a server restore (v1 recoverParkedChanges). */
  async recoverParkedChanges(): Promise<void> {
    const requeued = this.outbox.requeueParked();
    if (requeued > 0) this.callbacks.onParkedChanges?.(this.outbox.parkedCount());
    this.reportOutboxCounts();
    await this.syncOnce();
  }

  // --- push -------------------------------------------------------------------------

  async push(onProgress?: (progress: SyncPushProgress) => void): Promise<void> {
    const due = this.outbox.due(this.now());
    const total = due.length;
    let sent = 0;

    for (let i = 0; i < due.length; i += this.batchSize) {
      const chunk = due.slice(i, i + this.batchSize);
      const ids = chunk.map((entry) => entry.envelope.id);
      this.outbox.markInFlight(ids);
      try {
        await this.transport.sendBatch(chunk.map((entry) => entry.envelope));
        // Whole-chunk ack (v1): a 200 means every envelope is persisted
        // server-side — the server omits duplicate ids from savedIds, but
        // duplicate-only chunks still leave the outbox.
        this.outbox.markAcknowledged(ids);
        sent += chunk.length;
        onProgress?.({ sent, total });
      } catch (err) {
        const error = asError(err);
        this.outbox.markFailed(ids, error.message, this.now(), RETRY_DELAYS_MS);
        this.reportOutboxCounts();
        this.setStatus("error", error);
        this.callbacks.onError?.(error);
        throw error;
      }
    }

    this.reportOutboxCounts();
    if (total > 0) this.callbacks.onPush?.(total);
  }

  // --- pull --------------------------------------------------------------------------

  async pull(options: { ignoreSnapshot?: boolean; skipSnapshotUpload?: boolean } = {}): Promise<void> {
    this.pullInFlight = true;
    try {
      await this.pullInternal(options);
    } finally {
      this.pullInFlight = false;
      this.drainWsBuffer();
    }
  }

  private async pullInternal(options: {
    ignoreSnapshot?: boolean;
    skipSnapshotUpload?: boolean;
  }): Promise<void> {
    this.reportPhase("fetching-snapshot", "Fetching latest snapshot…");
    const meta = await this.transport.getSnapshotMeta();

    // Server restored/rebuilt: park un-synced ops, wipe, and resync from seq 0.
    if (meta.restoreEpoch !== this.restoreEpoch) {
      await this.resyncFromEpochChange(meta.restoreEpoch);
      return;
    }

    // Snapshot shortcut: restore the blob only when newer than the watermark,
    // then catch up from the seq the snapshot covers (null → 0; envelope-id
    // dedupe protects the replay).
    const snapshotIsNewer =
      !options.ignoreSnapshot &&
      meta.hasSnapshot &&
      compareHlc(meta.hlc, this.receivedHlc) > 0;
    if (snapshotIsNewer) {
      const data = await this.transport.getSnapshotData();
      this.store.restore(data);
      // The metadata HLC is the authoritative server-side watermark.
      this.receivedHlc = maxHlc(this.receivedHlc, meta.hlc);
      this.cursorSeq = meta.upToSeq ?? 0;
      this.persistState();
    }

    // Page by seq cursor; each page applied in one store transaction before
    // the next fetch, and the cursor advances per page so a crash mid-backlog
    // resumes from the last applied page.
    let afterSeq = this.cursorSeq;
    let totalEnvelopes = 0;
    let appliedOps = 0;
    for (;;) {
      const page = await this.transport.catchUp(afterSeq, this.catchUpLimit);
      if (page.restoreEpoch !== this.restoreEpoch) {
        await this.resyncFromEpochChange(page.restoreEpoch);
        return;
      }
      totalEnvelopes += page.envelopes.length;
      this.reportPhase(
        "catching-up",
        `Catching up… ${totalEnvelopes} operations`,
      );

      if (page.envelopes.length > 0) {
        // validateEnvelope fails loud on unknown opTypes / newer protocol
        // versions before the transaction opens.
        const envelopes = page.envelopes.map((input) => validateEnvelope(input));
        appliedOps += this.applyRemote(envelopes, null);
      }
      this.callbacks.onPullProgress?.({ applied: appliedOps, total: appliedOps + page.totalRemaining });

      if (page.nextAfterSeq !== null && page.nextAfterSeq > this.cursorSeq) {
        this.cursorSeq = page.nextAfterSeq;
        this.persistState();
      }
      if (!page.hasMore) break;
      if (page.nextAfterSeq === null) {
        // Defensive (v1): a hasMore page without a cursor would loop forever.
        break;
      }
      afterSeq = page.nextAfterSeq;
    }

    this.callbacks.onPull?.(totalEnvelopes);
    await this.maybeUploadSnapshot(meta, options.skipSnapshotUpload === true);
    this.reportPhase("synced", "Synced");
    this.reportOutboxCounts();
  }

  /** Server restoreEpoch changed: park unsent ops, wipe, full pull, requeue. */
  private async resyncFromEpochChange(newEpoch: number): Promise<void> {
    const parked = this.outbox.parkUnsent();
    if (parked > 0) this.callbacks.onParkedChanges?.(parked);
    this.store.reset();
    this.cursorSeq = 0;
    this.receivedHlc = ZERO_HLC;
    this.restoreEpoch = newEpoch;
    this.persistState();
    this.uploadedSnapshotHlc = null;

    await this.pullInternal({});
    const requeued = this.outbox.requeueParked();
    if (requeued > 0) this.callbacks.onParkedChanges?.(this.outbox.parkedCount());
    if (requeued > 0 || this.outbox.counts().pending > 0) {
      await this.push();
      await this.pullInternal({});
    }
  }

  /** Best-effort snapshot upload when the server has none or an older one (v1). */
  private async maybeUploadSnapshot(meta: SnapshotMeta, skip: boolean): Promise<void> {
    const upload = this.transport.uploadSnapshot?.bind(this.transport);
    if (!upload || skip) return;
    const newerThanServer = !meta.hasSnapshot || compareHlc(this.receivedHlc, meta.hlc) > 0;
    const newerThanUploaded =
      this.uploadedSnapshotHlc === null || compareHlc(this.receivedHlc, this.uploadedSnapshotHlc) > 0;
    if (!newerThanServer || !newerThanUploaded) return;
    try {
      const bytes = this.store.snapshot();
      await upload(bytes, this.receivedHlc);
      this.uploadedSnapshotHlc = this.receivedHlc;
    } catch {
      // Best-effort: a failed upload must not fail sync.
    }
  }

  // --- shared remote apply path (catch-up pages + realtime frames) -------------------

  /**
   * Apply a remote batch: one store transaction, conflict detection against
   * local un-acknowledged ops (reported, never blocking), HLC watermark +
   * device clock merge, and (when seqs are known) cursor advancement.
   * Returns the number of newly applied envelopes.
   */
  private applyRemote(envelopes: Envelope[], seqs: Record<string, number> | null): number {
    const ordered =
      seqs !== null
        ? [...envelopes].sort((a, b) => (seqs[a.id] ?? 0) - (seqs[b.id] ?? 0))
        : envelopes;

    const summaries = this.store.applyMany(ordered);

    const conflicts = detectConflicts(ordered, this.outbox.unacknowledgedEnvelopes());
    this.emitConflicts(conflicts);

    let maxIncoming: Hlc | null = null;
    for (const envelope of ordered) {
      this.receivedHlc = maxHlc(this.receivedHlc, envelope.hlc);
      maxIncoming = maxIncoming === null ? envelope.hlc : maxHlc(maxIncoming, envelope.hlc);
    }
    if (maxIncoming !== null) this.clock.update(maxIncoming);

    if (seqs !== null) {
      let maxSeq = this.cursorSeq;
      for (const envelope of ordered) {
        const seq = seqs[envelope.id];
        if (seq !== undefined && seq > maxSeq) maxSeq = seq;
      }
      if (maxSeq > this.cursorSeq) this.cursorSeq = maxSeq;
    }
    this.persistState();
    return summaries.filter((summary) => !summary.ignored).length;
  }

  // --- realtime hook surface (WS acceleration path) -------------------------------------

  /**
   * Apply a realtime ops frame (WIRE.md §2). Strictly an accelerator: frames
   * buffer while a pull runs so the seq cursor cannot regress past applied
   * frames, and any drop is recovered by the cursor on the next pull.
   */
  onRemoteBatch(envelopes: Envelope[], seqs: Record<string, number>): void {
    if (envelopes.length === 0) return;
    this.wsBuffer.push({ envelopes, seqs });
    if (!this.pullInFlight) this.drainWsBuffer();
  }

  /**
   * Wire the transport's realtime channel (subscribe), if it has one. Every
   * (re)connect sends a fresh `hello`, so a pull from the seq cursor covers
   * anything missed while the socket was down; `ack` frames acknowledge
   * outbox entries pushed over the socket (a no-op for HTTP-pushed ids).
   */
  startRealtime(): () => void {
    if (!this.transport.subscribe) return () => {};
    this.stopRealtime();
    this.unsubscribeRealtime = this.transport.subscribe({
      onOps: (envelopes, seqs) => this.onRemoteBatch(envelopes, seqs),
      onHello: (hello) => {
        if (
          hello.latestSeq > this.cursorSeq ||
          hello.restoreEpoch !== this.restoreEpoch
        ) {
          // Behind (or the server restored): catch up over HTTP — pull also
          // handles restoreEpoch changes.
          void this.pull().catch(() => {});
        } else {
          this.drainWsBuffer();
        }
      },
      onAck: (savedIds) => {
        this.outbox.markAcknowledged(savedIds);
        this.reportOutboxCounts();
      },
      onError: (error) => {
        this.setStatus("error", error);
        this.callbacks.onError?.(error);
      },
    });
    return () => this.stopRealtime();
  }

  stopRealtime(): void {
    this.unsubscribeRealtime?.();
    this.unsubscribeRealtime = null;
    this.wsBuffer = [];
  }

  private drainWsBuffer(): void {
    if (this.pullInFlight) return;
    while (this.wsBuffer.length > 0 && !this.pullInFlight) {
      const frame = this.wsBuffer.shift()!;
      try {
        const envelopes = frame.envelopes.map((input) => validateEnvelope(input));
        const applied = this.applyRemote(envelopes, frame.seqs);
        if (applied > 0) this.callbacks.onRemoteBatch?.(applied);
      } catch (err) {
        // v1: drop the remaining buffer — unapplied frames never advanced the
        // cursor, so the next pull re-fetches them through catch-up.
        this.wsBuffer = [];
        this.callbacks.onError?.(asError(err));
        return;
      }
    }
  }

  // --- sync cycle ------------------------------------------------------------------------

  async sync(options: { skipSnapshotUpload?: boolean } = {}): Promise<void> {
    await this.syncOnce(options);
  }

  /** One push+pull cycle; concurrent callers share the in-flight run (v1). */
  syncOnce(options: { skipSnapshotUpload?: boolean } = {}): Promise<void> {
    if (this.inFlightSync) return this.inFlightSync;
    this.inFlightSync = (async (): Promise<void> => {
      this.setStatus("syncing");
      try {
        await this.push();
        await this.pull(options);
        this.setStatus("idle", null);
      } catch (err) {
        const error = asError(err);
        this.setStatus("error", error);
        this.callbacks.onError?.(error);
        throw error;
      } finally {
        this.inFlightSync = null;
      }
    })();
    return this.inFlightSync;
  }

  startAutoSync(intervalMs: number): void {
    this.stopAutoSync();
    this.autoSyncTimer = setInterval(() => {
      void this.syncOnce().catch(() => {});
    }, intervalMs);
  }

  stopAutoSync(): void {
    if (this.autoSyncTimer !== null) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }
}
