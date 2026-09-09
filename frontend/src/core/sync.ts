import { compareHlc, maxHlc, type Hlc } from './clock';
import { CURRENT_DERIVED_STATE_VERSION } from './store';
import { RelayWsClient, type RelayPresenceAction, type RelayPresenceFrame, type RelayWsHello, type RelayWsStatus, type WebSocketLike } from './relayWs';
import {
  assertSupportedProtocolVersion,
  createOperation,
  PROTOCOL_VERSION,
  type Operation,
} from './types/operation';
import type { OperationEnvelope } from './crypto';
import { decryptEnvelopePayload, getWorkspaceKeyForVersion, isEncryptedPayload } from './e2ee';
import { detectConflicts, type SyncConflictInput } from './syncConflicts';
import type { IWorkspaceStoreClient } from './worker/workerProtocol';
import type { Transport } from './transport';
import { getLogger } from '@/utils/logger';

const log = getLogger('sync');

export type SyncStatus = 'idle' | 'syncing' | 'error';

export interface SyncPullProgress {
  applied: number;
  total: number;
}

export interface OutboxStatusCounts {
  pending: number;
  failed: number;
  quarantined: number;
}

export interface SyncEngineCallbacks {
  onPush?: (envelopeCount: number) => void;
  onPull?: (envelopeCount: number) => void;
  onPullProgress?: (progress: SyncPullProgress | null) => void;
  onError?: (error: Error) => void;
  onStatusChange?: (status: SyncStatus, error: Error | null) => void;
  /**
   * Called with the current outbox backlog after pushes and pulls so the UI
   * can show honest pending/failed counts (including quarantined ops, which
   * are otherwise invisible).
   */
  onOutboxCounts?: (counts: OutboxStatusCounts) => void;
  /**
   * Called when un-synced local ops were parked into the recovery branch
   * (or are found parked from an earlier session) because a server restore
   * invalidated local state. The user can re-push them via
   * recoverParkedChanges().
   */
  onParkedChanges?: (count: number) => void;
  /**
   * Called when the sync engine detects a semantic conflict between remote
   * operations and local pending operations (e.g. concurrent moves of the same
   * node, or a local edit vs a remote delete).
   */
  onConflict?: (conflicts: SyncConflictInput[]) => void;
  /**
   * Called when the sync engine enters a new high-level phase. Useful for
   * showing descriptive progress during initial workspace open.
   */
  onSyncPhase?: (phase: string, message: string) => void;
}

export interface OperationRow {
  id: string;
  workspace_id: string;
  actor_id: string;
  hlc_physical: number;
  hlc_logical: number;
  affected_node_ids: string;
  op_type: string;
  payload: string;
}

export class SyncEngine {
  private lastReceivedHlc: Hlc = { physical: 0, logical: 0 };
  private lastPushedHlc: Hlc = { physical: 0, logical: 0 };
  /** Server-assigned seq of the last applied envelope; the catch-up cursor. */
  private lastReceivedSeq = 0;
  private client: IWorkspaceStoreClient;
  private transport: Transport;
  private callbacks: SyncEngineCallbacks;
  private status: SyncStatus = 'idle';
  private lastError: Error | null = null;
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
  private statusListeners = new Set<(status: SyncStatus, error: Error | null) => void>();
  private conflictListeners = new Set<(conflicts: SyncConflictInput[]) => void>();
  /** HLC of the last snapshot we uploaded this session; avoid re-uploading. */
  private uploadedSnapshotHlc: Hlc | null = null;
  private watermarksLoaded = false;
  /** In-flight sync promise so concurrent calls (auto-sync + visibility + manual) share one run. */
  private inFlightSync: Promise<void> | null = null;
  /** Realtime channel state (WS is an acceleration path; the seq cursor stays authoritative). */
  private wsClient: RelayWsClient | null = null;
  private wsBuffer: Array<{ envelopes: OperationEnvelope[]; seqs: Record<string, number> }> = [];
  private wsDraining = false;
  private pullInFlight = false;
  /** Presence frame subscribers (ephemeral; never touch the seq cursor). */
  private presenceListeners = new Set<(frame: RelayPresenceFrame) => void>();
  private realtimeStatusListeners = new Set<(status: RelayWsStatus) => void>();

  constructor(client: IWorkspaceStoreClient, transport: Transport, callbacks: SyncEngineCallbacks = {}) {
    this.client = client;
    this.transport = transport;
    this.callbacks = callbacks;
  }

  private reportPhase(phase: string, message: string): void {
    this.callbacks.onSyncPhase?.(phase, message);
  }

  private async ensureWatermarksLoaded(): Promise<void> {
    if (this.watermarksLoaded) return;
    const watermarks = await this.client.query<{
      received: Hlc;
      pushed: Hlc;
      receivedSeq: number;
    }>('loadWatermarks', []);
    this.lastReceivedHlc = watermarks.received;
    this.lastPushedHlc = watermarks.pushed;
    this.lastReceivedSeq = watermarks.receivedSeq;
    this.watermarksLoaded = true;
  }

  private async loadRestoreEpoch(): Promise<number> {
    const watermarks = await this.client.query<{ received: Hlc; pushed: Hlc; restoreEpoch: number }>(
      'loadWatermarks',
      []
    );
    return watermarks.restoreEpoch;
  }

  private async saveWatermark(hlc: Hlc, kind: 'received' | 'pushed'): Promise<void> {
    await this.client.mutate('saveWatermark', [kind, hlc]);
  }

  private async saveSeqCursor(seq: number): Promise<void> {
    await this.client.mutate('saveSeqCursor', [seq]);
  }

  private async saveRestoreEpoch(epoch: number): Promise<void> {
    await this.client.mutate('saveRestoreEpoch', [epoch, this.lastReceivedHlc]);
  }

  private setStatus(status: SyncStatus, error: Error | null = null): void {
    this.status = status;
    this.lastError = error;
    this.callbacks.onStatusChange?.(status, error);
    for (const listener of this.statusListeners) {
      listener(status, error);
    }
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  getLastError(): Error | null {
    return this.lastError;
  }

  subscribeStatus(callback: (status: SyncStatus, error: Error | null) => void): () => void {
    // Emit current status immediately so consumers start with the right value.
    callback(this.status, this.lastError);

    this.statusListeners.add(callback);
    return () => {
      this.statusListeners.delete(callback);
    };
  }

  subscribeConflicts(callback: (conflicts: SyncConflictInput[]) => void): () => void {
    this.conflictListeners.add(callback);
    return () => {
      this.conflictListeners.delete(callback);
    };
  }

  private emitConflicts(conflicts: SyncConflictInput[]): void {
    if (conflicts.length === 0) return;
    this.callbacks.onConflict?.(conflicts);
    for (const listener of this.conflictListeners) {
      listener(conflicts);
    }
  }

  async push(onProgress?: (progress: { sent: number; total: number }) => void): Promise<void> {
    await this.ensureWatermarksLoaded();
    await this.reportOutboxCounts();

    const SEND_BATCH_SIZE = 100;
    const QUERY_BATCH_SIZE = 1000;
    const RETRY_DELAYS_MS = [5000, 15000, 60000, 300000, 1800000];
    const workspaceId = await this.client.query<string>('getWorkspaceId', []);
    const toEnvelope = (row: OperationRow) => ({
      id: row.id,
      protocolVersion: PROTOCOL_VERSION,
      workspaceId,
      actorId: row.actor_id,
      hlc: { physical: row.hlc_physical, logical: row.hlc_logical },
      affectedNodeIds: JSON.parse(row.affected_node_ids),
      opType: row.op_type,
      payload: JSON.parse(row.payload),
    });

    let totalPushed = 0;
    let sent = 0;
    let hasMore = true;

    // Total is measured once up front for determinate progress. It can drift if
    // new ops are created mid-push; callers should clamp the fraction to 1.
    const total = onProgress
      ? await this.client.query<number>('countPendingPushOperations', [this.lastPushedHlc, Date.now()])
      : 0;

    // Query and push in smaller chunks so a large local operation log does not
    // block the main thread with a single huge SELECT *. Recompute the HLC
    // params each iteration because lastPushedHlc advances after every chunk.
    while (hasMore) {
      const rows = await this.client.query<OperationRow[]>('getPendingPushOperations', [
        this.lastPushedHlc,
        QUERY_BATCH_SIZE,
        Date.now(),
      ]);

      if (rows.length === 0) {
        await this.reportOutboxCounts();
        return;
      }

      hasMore = rows.length === QUERY_BATCH_SIZE;
      totalPushed += rows.length;

      for (let i = 0; i < rows.length; i += SEND_BATCH_SIZE) {
        const chunkRows = rows.slice(i, i + SEND_BATCH_SIZE);
        const chunk = chunkRows.map(toEnvelope);
        const chunkIds = chunk.map((e) => e.id);

        await this.client.mutate('markOperationsInFlight', [chunkIds]);

        try {
          if (this.transport.sendBatch) {
            await this.transport.sendBatch(chunk);
          } else {
            await this.sendBatchViaSend(chunk);
          }

          // A successful batch response means every envelope in the chunk is
          // persisted server-side: the server omits duplicates from saved_ids
          // (app/relay/storage.py save_envelopes) and validation or permission
          // failures throw instead. Ack the whole chunk so duplicate-only
          // chunks still advance the push watermark — otherwise a client whose
          // push watermark was reset (e.g. an interrupted rebuild) re-sends
          // the same server-known operations forever and initialize() hangs.
          await this.client.mutate('markOperationsAcknowledged', [chunkIds]);

          let ackMaxHlc: Hlc | null = null;
          for (const envelope of chunk) {
            ackMaxHlc = ackMaxHlc === null ? envelope.hlc : maxHlc(ackMaxHlc, envelope.hlc);
          }

          if (ackMaxHlc !== null) {
            this.lastPushedHlc = ackMaxHlc;
            await this.saveWatermark(this.lastPushedHlc, 'pushed');
          }

          // Progress for explicit user-triggered pushes (command palette).
          // Count only acknowledged chunks so the number never overstates.
          sent += chunkRows.length;
          onProgress?.({ sent, total });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          const attemptCounts = await this.client.query<Record<string, number>>(
            'getOutboxAttemptCounts',
            [chunkIds]
          );
          const maxAttempt = Math.max(0, ...Object.values(attemptCounts));
          // After the backoff schedule is exhausted the op quarantines
          // (nextRetryAt = null) and stops auto-retrying; it only comes back
          // through an explicit retry (retryQuarantined).
          const delayIndex = maxAttempt - 1;
          const nextRetryAt =
            delayIndex >= 0 && delayIndex < RETRY_DELAYS_MS.length
              ? Date.now() + RETRY_DELAYS_MS[delayIndex]
              : null;
          await this.client.mutate('markOperationsFailed', [
            chunkIds,
            error.message,
            nextRetryAt,
          ]);
          await this.reportOutboxCounts();
          this.setStatus('error', error);
          this.callbacks.onError?.(error);
          throw error;
        }
      }
    }

    await this.reportOutboxCounts();
    this.callbacks.onPush?.(totalPushed);
  }

  /** Report the current outbox backlog; never breaks sync on failure. */
  private async reportOutboxCounts(): Promise<void> {
    if (!this.callbacks.onOutboxCounts) return;
    try {
      const counts = await this.client.query<OutboxStatusCounts>('getOutboxStatusCounts', [
        this.lastPushedHlc,
      ]);
      this.callbacks.onOutboxCounts(counts);
    } catch (err) {
      log.warn('Failed to report outbox counts', { error: String(err) });
    }
  }

  /**
   * Requeue quarantined ops (which exhausted their backoff schedule and are
   * otherwise stuck forever) and push them immediately.
   */
  async retryQuarantined(): Promise<void> {
    await this.ensureWatermarksLoaded();
    await this.client.mutate('requeueQuarantinedOperations', []);
    await this.reportOutboxCounts();
    await this.syncOnce();
  }

  /**
   * Park un-acknowledged local ops before a server-restore wipe so they are
   * not silently discarded. Returns the number parked.
   */
  private async parkUnsyncedOperations(): Promise<number> {
    const parked = await this.client.mutate<number>('parkUnsyncedOperations', ['server-restore']);
    if (parked > 0) {
      log.warn('Parked un-synced local operations before server-restore rebuild', { parked });
      this.callbacks.onParkedChanges?.(parked);
    }
    return parked;
  }

  /** Emit the parked-changes callback when ops are waiting in the recovery branch. */
  private async reportParkedChanges(): Promise<void> {
    if (!this.callbacks.onParkedChanges) return;
    try {
      const count = await this.client.query<number>('countParkedOperations', []);
      if (count > 0) {
        this.callbacks.onParkedChanges(count);
      }
    } catch (err) {
      log.warn('Failed to report parked changes', { error: String(err) });
    }
  }

  /**
   * Re-push ops parked by a server restore: they re-enter the outbox, are
   * re-applied locally, and push on the next sync. Their effects resolve
   * against the restored server state through normal LWW/CRDT semantics.
   */
  async recoverParkedChanges(): Promise<void> {
    await this.ensureWatermarksLoaded();
    const requeued = await this.client.mutate<number>('requeueParkedOperations', []);
    if (requeued > 0) {
      log.info('Recovered parked operations', { requeued });
    }
    this.callbacks.onParkedChanges?.(0);
    await this.reportOutboxCounts();
    await this.syncOnce();
  }

  /**
   * Start the realtime channel: committed ops are pushed to this client over
   * the relay WebSocket and applied immediately. Strictly an acceleration
   * path — the seq cursor + HTTP catch-up remain the recovery mechanism, so
   * visibility/online-triggered syncs stay registered alongside.
   */
  startRealtime(options: {
    workspaceId: string;
    baseUrl?: string;
    createSocket?: (url: string) => WebSocketLike;
  }): void {
    if (this.wsClient) return;
    this.wsClient = new RelayWsClient({
      workspaceId: options.workspaceId,
      baseUrl: options.baseUrl,
      createSocket: options.createSocket,
      callbacks: {
        onHello: (hello) => this.handleWsHello(hello),
        onOps: (envelopes, seqs) => this.handleWsOps(envelopes, seqs),
        onPresence: (frame) => {
          for (const listener of this.presenceListeners) {
            try {
              listener(frame);
            } catch (err) {
              log.warn('Presence listener failed', { error: String(err) });
            }
          }
        },
        onStatusChange: (status) => {
          for (const listener of this.realtimeStatusListeners) {
            listener(status);
          }
        },
        onFatal: (message) => {
          log.error('Realtime channel stopped fatally', { message });
          const error = new Error(message);
          this.setStatus('error', error);
          this.callbacks.onError?.(error);
        },
        onClose: () => {
          // Reconnect is handled inside RelayWsClient; no status change — a
          // dropped socket is indistinguishable from a delayed one.
        },
      },
    });
    this.wsClient.connect();
  }

  /** Close the realtime channel intentionally (workspace switch/teardown). */
  stopRealtime(): void {
    this.wsClient?.close();
    this.wsClient = null;
    this.wsBuffer = [];
  }

  /**
   * Send an ephemeral presence frame (focus/blur/typing) for a block. A safe
   * no-op when the realtime channel is not started or not currently open.
   */
  sendPresence(action: RelayPresenceAction, blockUuid: string): void {
    this.wsClient?.send({ type: 'presence', action, blockUuid });
  }

  /** Subscribe to presence frames from workspace peers. Returns an unsubscribe. */
  subscribePresence(listener: (frame: RelayPresenceFrame) => void): () => void {
    this.presenceListeners.add(listener);
    return () => this.presenceListeners.delete(listener);
  }

  /** Realtime channel status; 'disconnected' when no realtime channel runs. */
  getRealtimeStatus(): RelayWsStatus {
    return this.wsClient?.getStatus() ?? 'disconnected';
  }

  /** Subscribe to realtime status changes; emits the current status first. */
  subscribeRealtimeStatus(listener: (status: RelayWsStatus) => void): () => void {
    this.realtimeStatusListeners.add(listener);
    listener(this.getRealtimeStatus());
    return () => this.realtimeStatusListeners.delete(listener);
  }

  private handleWsHello(hello: RelayWsHello): void {
    // Behind → catch up over HTTP (pull also handles restoreEpoch mismatch);
    // pull's finally drains any buffered frames. Not behind → drain now.
    if (hello.latestSeq > this.lastReceivedSeq) {
      void this.syncOnce().catch((err) => {
        log.warn('Sync after WS hello failed', { error: String(err) });
      });
    } else {
      this.drainWsBuffer();
    }
  }

  private handleWsOps(envelopes: OperationEnvelope[], seqs: Record<string, number>): void {
    if (envelopes.length === 0) return;
    this.wsBuffer.push({ envelopes, seqs });
    // Buffer while a pull is in flight so the pull's seq cursor cannot
    // regress past frames we already applied; the pull drains us at the end.
    if (!this.pullInFlight) {
      this.drainWsBuffer();
    }
  }

  private drainWsBuffer(): void {
    if (this.wsDraining || this.wsBuffer.length === 0 || this.pullInFlight) return;
    this.wsDraining = true;
    void (async () => {
      try {
        while (this.wsBuffer.length > 0 && !this.pullInFlight) {
          const frame = this.wsBuffer.shift();
          if (!frame) break;
          await this.applyWsFrame(frame.envelopes, frame.seqs);
        }
      } catch (err) {
        // Drop the remaining buffer: unapplied frames never advanced the seq
        // cursor, so the next pull re-fetches them through catch-up.
        log.warn('Failed to apply realtime ops; next pull will catch up', {
          error: String(err),
        });
        this.wsBuffer = [];
      } finally {
        this.wsDraining = false;
      }
    })();
  }

  private async applyWsFrame(
    envelopes: OperationEnvelope[],
    seqs: Record<string, number>
  ): Promise<void> {
    const workspaceId = await this.client.query<string>('getWorkspaceId', []);
    // E2EE: live frames arrive encrypted; a locked workspace fails loud here
    // (the drain drops the frame, and the next pull fails the same way).
    let incoming = envelopes;
    if (envelopes.some((env) => isEncryptedPayload(env.payload))) {
      incoming = await Promise.all(
        envelopes.map(async (env) => {
          if (!isEncryptedPayload(env.payload)) return env;
          const key = getWorkspaceKeyForVersion(workspaceId, env.payload.$e.kv ?? 1);
          if (!key) {
            throw new Error('Workspace is end-to-end encrypted and locked: enter the passphrase to sync.');
          }
          return decryptEnvelopePayload(key, env);
        })
      );
    }
    for (const env of incoming) {
      assertSupportedProtocolVersion(env);
    }
    const sorted = [...incoming].sort((a, b) => (seqs[a.id] ?? 0) - (seqs[b.id] ?? 0));
    const ops = sorted.map((env) =>
      createOperation(
        {
          id: env.id,
          workspaceId,
          actorId: env.actorId,
          hlc: env.hlc,
          affectedNodeIds: env.affectedNodeIds,
          opType: env.opType,
        },
        env.payload
      )
    );
    await this.client.mutate('applyMany', [ops]);

    let maxSeq = this.lastReceivedSeq;
    let maxRecvHlc = this.lastReceivedHlc;
    for (const env of envelopes) {
      const seq = seqs[env.id];
      if (seq !== undefined && seq > maxSeq) maxSeq = seq;
      if (compareHlc(env.hlc, maxRecvHlc) > 0) maxRecvHlc = env.hlc;
    }
    if (maxSeq > this.lastReceivedSeq) {
      this.lastReceivedSeq = maxSeq;
      await this.saveSeqCursor(maxSeq);
    }
    if (compareHlc(maxRecvHlc, this.lastReceivedHlc) > 0) {
      this.lastReceivedHlc = maxRecvHlc;
      await this.saveWatermark(maxRecvHlc, 'received');
    }
    await this.reportOutboxCounts();
  }

  private async sendBatchViaSend(envelopes: OperationEnvelope[]): Promise<{ savedIds: string[] }> {
    const savedIds: string[] = [];
    for (const envelope of envelopes) {
      const result = await this.transport.send(envelope);
      savedIds.push(...result.savedIds);
    }
    return { savedIds };
  }

  async pull(options: { ignoreSnapshot?: boolean; skipSnapshotUpload?: boolean } = {}): Promise<void> {
    // Realtime frames are buffered while a pull runs so the pull's seq cursor
    // cannot regress past frames already applied; they drain in the finally.
    this.pullInFlight = true;
    try {
      await this.pullInternal(options);
    } finally {
      this.pullInFlight = false;
      this.drainWsBuffer();
    }
  }

  private async pullInternal(options: { ignoreSnapshot?: boolean; skipSnapshotUpload?: boolean } = {}): Promise<void> {
    await this.ensureWatermarksLoaded();

    this.reportPhase('fetching-snapshot', 'Fetching latest snapshot…');
    // Probe metadata first: the snapshot blob can be tens of megabytes and is
    // discarded whenever the snapshot is not newer than our local watermark.
    const snapshot = await this.transport.getLatestSnapshot({ includeData: false });
    const localEpoch = await this.loadRestoreEpoch();
    const localReceivedHlc = this.lastReceivedHlc;
    log.info('pull snapshot info', {
      hasSnapshot: snapshot.hasSnapshot,
      snapshotHlc: snapshot.hlc,
      localReceivedHlc,
      localEpoch,
      snapshotRestoreEpoch: snapshot.restoreEpoch,
    });

    // If the server was restored or rebuilt, clear local state and start over.
    // The operation log is the source of truth; re-applying all operations from
    // the restored server converges to the correct state.
    if (snapshot.restoreEpoch !== localEpoch) {
      // A server restore means the server's derived state may differ from ours.
      // Park un-synced local ops first so the wipe does not silently discard
      // them, then clear derived tables as well as the operation log so the
      // next catch-up rebuilds everything from a clean baseline.
      await this.parkUnsyncedOperations();
      await this.client.mutate('resetDerivedState', []);
      await this.client.mutate('clearOperationLog', []);
      this.lastReceivedHlc = { physical: 0, logical: 0 };
      this.lastPushedHlc = { physical: 0, logical: 0 };
      this.lastReceivedSeq = 0;
      await this.saveWatermark(this.lastReceivedHlc, 'received');
      await this.saveWatermark(this.lastPushedHlc, 'pushed');
      await this.saveSeqCursor(0);
      await this.saveRestoreEpoch(snapshot.restoreEpoch);
      this.uploadedSnapshotHlc = null;
    }

    // Try to restore from the latest server snapshot. If the snapshot is newer
    // than our local watermark, replace the derived DB with it and then only
    // replay operations newer than the snapshot.
    //
    // ignoreSnapshot is used during a hard rebuild: the derived state may have
    // been produced by an older applier, so we replay the full operation log
    // instead of trusting a possibly stale snapshot.
    const snapshotIsNewer =
      !options.ignoreSnapshot &&
      snapshot.hasSnapshot &&
      compareHlc(snapshot.hlc, this.lastReceivedHlc) > 0;

    log.info('pull snapshot decision', {
      snapshotIsNewer,
      ignoreSnapshot: options.ignoreSnapshot,
      localReceivedHlc,
      snapshotHlc: snapshot.hlc,
    });

    if (snapshotIsNewer) {
      this.callbacks.onPullProgress?.({ applied: 0, total: 0 });
      // The metadata probe carries no payload; fetch the full snapshot now
      // that we know we will actually restore from it.
      const fullSnapshot = await this.transport.getLatestSnapshot();
      const restoredHlc = await this.client.mutate<{ physical: number; logical: number }>(
        'restoreSnapshot',
        [fullSnapshot.data]
      );
      // The snapshot metadata HLC is the authoritative watermark the server used
      // when it created the snapshot. Some snapshots (e.g. uploaded after local
      // compaction or from clients that don't keep the operation log) report a
      // lower HLC from their operation table than their metadata claims. Using the
      // metadata HLC ensures we don't re-fetch and re-apply the entire log.
      this.lastReceivedHlc = maxHlc(restoredHlc, fullSnapshot.hlc);
      await this.saveWatermark(this.lastReceivedHlc, 'received');
      // Resume catch-up from the seq the snapshot covers. Null upToSeq means
      // the snapshot predates the seq cursor: replay from 0, protected by
      // operation-id dedupe.
      this.lastReceivedSeq = fullSnapshot.upToSeq ?? 0;
      await this.saveSeqCursor(this.lastReceivedSeq);
    }

    // Page the server by seq cursor, applying each page before fetching the
    // next so a large backlog never accumulates in memory. Pages arrive in
    // seq order; envelopes within a page are applied in (HLC, id) order, and
    // the cursor advances per applied page so a crash mid-backlog resumes
    // from the last applied page instead of from zero.
    log.info('pull catching up', {
      afterSeq: this.lastReceivedSeq,
    });
    const workspaceId = await this.client.query<string>('getWorkspaceId', []);
    let afterSeq = this.lastReceivedSeq;
    let totalEnvelopes = 0;
    const previousReceivedHlc = this.lastReceivedHlc;
    for (;;) {
      const page = await this.transport.catchUp(afterSeq);
      const pageEnvelopes = page.envelopes;
      totalEnvelopes += pageEnvelopes.length;
      this.reportPhase('catching-up', `Catching up with server… ${totalEnvelopes} operations`);

      if (pageEnvelopes.length > 0) {
        // Fail loud when a peer speaks a newer protocol than we understand:
        // applying operations we cannot interpret would silently corrupt
        // derived state. The error propagates to syncOnce, which surfaces it
        // via the 'error' status and onError callback.
        for (const env of pageEnvelopes) {
          assertSupportedProtocolVersion(env);
        }

        pageEnvelopes.sort((a, b) => {
          const cmp = compareHlc(a.hlc, b.hlc);
          if (cmp !== 0) return cmp;
          return a.id.localeCompare(b.id);
        });

        const ops = pageEnvelopes.map((env) =>
          createOperation(
            {
              id: env.id,
              workspaceId,
              actorId: env.actorId,
              hlc: env.hlc,
              affectedNodeIds: env.affectedNodeIds,
              opType: env.opType,
            },
            env.payload
          )
        );

        // Apply the page in the worker. The worker runs off the main thread,
        // so we no longer need to chunk and yield to keep the UI responsive.
        this.reportPhase('applying-operations', `Applying ${ops.length.toLocaleString()} operations…`);
        this.callbacks.onPullProgress?.({ applied: 0, total: ops.length });
        const unsubscribeProgress = this.client.subscribeProgress((applied, total) => {
          this.reportPhase('applying-operations', `Applying ${applied.toLocaleString()} / ${total.toLocaleString()} operations…`);
          this.callbacks.onPullProgress?.({ applied, total });
        });
        await this.client.mutate('startBatch', []);
        try {
          const applied = await this.client.mutate<number>('applyMany', [ops]);
          this.callbacks.onPullProgress?.({ applied, total: ops.length });
        } finally {
          unsubscribeProgress();
          await this.client.mutate('endBatch', []);
        }

        // Detect semantic conflicts between the remote operations we just
        // applied and any local operations that are still pending.
        const affectedNodeIds = new Set<string>();
        for (const op of ops) {
          for (const nodeId of op.envelope.affectedNodeIds) {
            affectedNodeIds.add(nodeId);
          }
        }
        if (affectedNodeIds.size > 0) {
          const localPendingOps = await this.client.query<Operation[]>('getPendingLocalOperations', [
            Array.from(affectedNodeIds),
          ]);
          const conflicts = detectConflicts(ops, localPendingOps);
          this.emitConflicts(conflicts);
        }

        for (const op of ops) {
          this.lastReceivedHlc = maxHlc(this.lastReceivedHlc, op.envelope.hlc);
        }
        await this.saveWatermark(this.lastReceivedHlc, 'received');
      }

      // Advance the cursor per page. The final page carries a cursor too (the
      // router sets next_after_seq on it), so the tail is not re-fetched.
      if (page.nextAfterSeq !== null && page.nextAfterSeq > this.lastReceivedSeq) {
        this.lastReceivedSeq = page.nextAfterSeq;
        await this.saveSeqCursor(this.lastReceivedSeq);
      }
      this.callbacks.onPullProgress?.({ applied: 0, total: totalEnvelopes });

      if (!page.hasMore) break;
      if (page.nextAfterSeq === null) {
        // Defensive: a server that reports hasMore without a cursor would loop
        // forever. Bail out; the next pull resumes from the last good cursor.
        log.warn('catch-up page reported hasMore without nextAfterSeq; stopping pagination');
        break;
      }
      afterSeq = page.nextAfterSeq;
    }
    log.info('pull catch-up result', { envelopeCount: totalEnvelopes });

    await this.saveRestoreEpoch(snapshot.restoreEpoch);
    // Flush the SQLite DB to IndexedDB so the watermark and operation log survive
    // a page reload. Large catch-ups need an immediate flush because a lot of state
    // changed. Tiny catch-ups (e.g. one remote edit) do not need to block the UI
    // with a 100+ MB IndexedDB write right now; the debounced scheduler will flush
    // the watermark and the single applied operation within a few hundred ms.
    const hlcAdvanced = compareHlc(this.lastReceivedHlc, previousReceivedHlc) > 0;
    if (totalEnvelopes > 10) {
      await this.client.mutate('persistNow', []);
    } else if (totalEnvelopes > 0 || hlcAdvanced) {
      await this.client.mutate('schedulePersist', []);
    }
    this.reportPhase('synced', 'Synced');
    await this.reportOutboxCounts();
    await this.reportParkedChanges();
    this.callbacks.onPull?.(totalEnvelopes);

    // Upload a snapshot when the server has no snapshot or an older one.
    // This helps the next device open quickly. Keep it best-effort.
    const uploadSnapshot = this.transport.uploadSnapshot?.bind(this.transport);
    const shouldUploadSnapshot =
      uploadSnapshot &&
      (!snapshot.hasSnapshot || compareHlc(this.lastReceivedHlc, snapshot.hlc) > 0) &&
      (!this.uploadedSnapshotHlc ||
        compareHlc(this.lastReceivedHlc, this.uploadedSnapshotHlc) > 0);

    if (!options.skipSnapshotUpload && shouldUploadSnapshot && uploadSnapshot) {
      // Snapshot upload is best-effort and can take a long time for large
      // workspaces. Don't block the initial sync / workspace open on it; run it
      // in the background so the UI becomes interactive immediately.
      void (async () => {
        try {
          const { hlc, data } = await this.client.query<{ hlc: Hlc; data: Uint8Array }>(
            'exportSnapshot',
            [this.lastReceivedHlc]
          );
          await uploadSnapshot({
            snapshotId: '',
            workspaceId,
            hlc,
            data,
            restoreEpoch: snapshot.restoreEpoch,
            hasSnapshot: true,
            // The exported derived DB covers everything up to our current
            // cursor; the server records it as the snapshot's up_to_seq.
            upToSeq: this.lastReceivedSeq,
          });
          this.uploadedSnapshotHlc = hlc;
        } catch (err) {
          // Snapshot upload is best-effort; don't fail sync if upload errors.
          console.error('Failed to upload workspace snapshot', err);
        }
      })();
    }

  }

  async sync(): Promise<void> {
    await this.syncOnce();
  }

  /**
   * One-time initialization when a workspace store is opened. If the client
   * applier version has changed, this performs a hard rebuild: derived tables
   * are cleared, local snapshots are discarded, and the full operation log is
   * replayed from the server using the new applier.
   */
  async initialize(): Promise<void> {
    await this.ensureWatermarksLoaded();

    const isStale = await this.client.query<boolean>('isDerivedStateStale', []);
    if (!isStale) {
      // Skip snapshot upload during initial open: exporting and uploading a large
      // derived database while the user is waiting can freeze lower-powered
      // machines. Uploads happen later during background auto-sync.
      await this.syncOnce({ skipSnapshotUpload: true });
      // Surface ops parked by a server restore in a previous session.
      await this.reportParkedChanges();
      return;
    }

    this.setStatus('syncing');
    try {
      // Fetch server restore metadata before deciding whether to push local ops.
      // If the server was restored, local state is stale by definition and we
      // must not push potentially stale local operations back upstream. In the
      // normal case (applier update only), preserve local offline edits by
      // pushing them first.
      this.reportPhase('fetching-snapshot', 'Fetching latest snapshot…');
      // Only restoreEpoch is read here; skip the snapshot blob entirely.
      const serverSnapshot = await this.transport.getLatestSnapshot({ includeData: false });
      const localEpoch = await this.loadRestoreEpoch();
      const serverRestored = serverSnapshot.restoreEpoch !== localEpoch;

      if (serverRestored) {
        // The server was restored from a backup: local un-synced ops may not
        // exist server-side anymore. Park them into the recovery branch
        // instead of silently discarding them with the wipe below.
        log.warn(
          `Server restore_epoch ${serverSnapshot.restoreEpoch} differs from local ${localEpoch}; ` +
            'parking un-synced local ops and rebuilding from server.'
        );
        await this.parkUnsyncedOperations();
      } else {
        this.reportPhase('pushing-local', 'Sending local changes…');
        await this.push();
      }

      this.reportPhase('rebuilding-state', 'Rebuilding local state…');
      await this.client.mutate('resetDerivedState', []);
      await this.client.mutate('clearOperationLog', []);
      this.lastReceivedHlc = { physical: 0, logical: 0 };
      this.lastPushedHlc = { physical: 0, logical: 0 };
      this.lastReceivedSeq = 0;
      await this.saveWatermark(this.lastReceivedHlc, 'received');
      await this.saveWatermark(this.lastPushedHlc, 'pushed');
      await this.saveSeqCursor(0);
      await this.saveRestoreEpoch(serverSnapshot.restoreEpoch);
      this.uploadedSnapshotHlc = null;
      this.reportPhase('pulling-operations', 'Pulling operations from server…');
      await this.pull({ ignoreSnapshot: true });
      // Stamp the new applier version only after the rebuild completed
      // successfully — an interrupted rebuild must stay "stale" so the next
      // open retries it instead of keeping wiped tables marked as current.
      await this.client.mutate('setDerivedStateVersion', [CURRENT_DERIVED_STATE_VERSION]);
      await this.client.mutate('persistNow', []);
      this.setStatus('idle', null);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.setStatus('error', error);
      this.callbacks.onError?.(error);
      throw error;
    }
  }

  syncOnce(options: { skipSnapshotUpload?: boolean } = {}): Promise<void> {
    if (this.inFlightSync) {
      return this.inFlightSync;
    }

    this.inFlightSync = (async (): Promise<void> => {
      this.setStatus('syncing');
      try {
        await this.push();
        await this.pull({ skipSnapshotUpload: options.skipSnapshotUpload });
        this.setStatus('idle', null);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.setStatus('error', error);
        this.callbacks.onError?.(error);
        throw error;
      } finally {
        this.inFlightSync = null;
      }
    })();

    return this.inFlightSync;
  }

  /**
   * Reset the received seq cursor to zero, clear the local operation log, and
   * pull everything from the server. Re-applying operations repairs derived
   * state that may have been produced by an older applier version.
   */
  async forceResync(): Promise<void> {
    await this.ensureWatermarksLoaded();

    await this.client.mutate('clearOperationLog', []);
    this.lastReceivedHlc = { physical: 0, logical: 0 };
    this.lastPushedHlc = { physical: 0, logical: 0 };
    this.lastReceivedSeq = 0;
    await this.saveWatermark(this.lastReceivedHlc, 'received');
    await this.saveWatermark(this.lastPushedHlc, 'pushed');
    await this.saveSeqCursor(0);
    this.uploadedSnapshotHlc = null;
    await this.syncOnce();
    // Note: we intentionally do not reset restoreEpoch here. syncOnce -> pull
    // will compare the local epoch with the server's and handle a mismatch.
  }

  startAutoSync(intervalMs: number): void {
    this.stopAutoSync();
    this.autoSyncTimer = setInterval(() => {
      void this.syncOnce();
    }, intervalMs);
  }

  stopAutoSync(): void {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }
}
