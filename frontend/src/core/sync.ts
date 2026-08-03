import { compareHlc, maxHlc, type Hlc } from './clock';
import { createOperation, type Operation } from './types/operation';
import type { OperationEnvelope } from './crypto';
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

export interface SyncEngineCallbacks {
  onPush?: (envelopeCount: number) => void;
  onPull?: (envelopeCount: number) => void;
  onPullProgress?: (progress: SyncPullProgress | null) => void;
  onError?: (error: Error) => void;
  onStatusChange?: (status: SyncStatus, error: Error | null) => void;
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
    const watermarks = await this.client.query<{ received: Hlc; pushed: Hlc }>('loadWatermarks', []);
    this.lastReceivedHlc = watermarks.received;
    this.lastPushedHlc = watermarks.pushed;
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

  async push(): Promise<void> {
    await this.ensureWatermarksLoaded();

    const SEND_BATCH_SIZE = 100;
    const QUERY_BATCH_SIZE = 1000;
    const RETRY_DELAYS_MS = [5000, 15000, 60000, 300000, 1800000];
    const workspaceId = await this.client.query<string>('getWorkspaceId', []);
    const toEnvelope = (row: OperationRow) => ({
      id: row.id,
      workspaceId,
      actorId: row.actor_id,
      hlc: { physical: row.hlc_physical, logical: row.hlc_logical },
      affectedNodeIds: JSON.parse(row.affected_node_ids),
      opType: row.op_type,
      payload: JSON.parse(row.payload),
    });

    let totalPushed = 0;
    let hasMore = true;

    // Query and push in smaller chunks so a large local operation log does not
    // block the main thread with a single huge SELECT *. Recompute the HLC
    // params each iteration because lastPushedHlc advances after every chunk.
    while (hasMore) {
      const rows = await this.client.query<OperationRow[]>('getPendingPushOperations', [
        this.lastPushedHlc,
        QUERY_BATCH_SIZE,
        Date.now(),
      ]);

      if (rows.length === 0) return;

      hasMore = rows.length === QUERY_BATCH_SIZE;
      totalPushed += rows.length;

      for (let i = 0; i < rows.length; i += SEND_BATCH_SIZE) {
        const chunkRows = rows.slice(i, i + SEND_BATCH_SIZE);
        const chunk = chunkRows.map(toEnvelope);
        const chunkIds = chunk.map((e) => e.id);

        await this.client.mutate('markOperationsInFlight', [chunkIds]);

        try {
          const result = this.transport.sendBatch
            ? await this.transport.sendBatch(chunk)
            : await this.sendBatchViaSend(chunk);

          const ackIds = new Set(result.savedIds);
          await this.client.mutate('markOperationsAcknowledged', [Array.from(ackIds)]);

          let ackMaxHlc: Hlc | null = null;
          for (const envelope of chunk) {
            if (ackIds.has(envelope.id)) {
              ackMaxHlc = ackMaxHlc === null ? envelope.hlc : maxHlc(ackMaxHlc, envelope.hlc);
            }
          }

          if (ackMaxHlc !== null) {
            this.lastPushedHlc = ackMaxHlc;
            await this.saveWatermark(this.lastPushedHlc, 'pushed');
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          const attemptCounts = await this.client.query<Record<string, number>>(
            'getOutboxAttemptCounts',
            [chunkIds]
          );
          const maxAttempt = Math.max(0, ...Object.values(attemptCounts));
          const delayIndex = Math.min(maxAttempt - 1, RETRY_DELAYS_MS.length - 1);
          const nextRetryAt = delayIndex >= 0 ? Date.now() + RETRY_DELAYS_MS[delayIndex] : null;
          await this.client.mutate('markOperationsFailed', [
            chunkIds,
            error.message,
            nextRetryAt,
          ]);
          this.setStatus('error', error);
          this.callbacks.onError?.(error);
          throw error;
        }
      }
    }

    this.callbacks.onPush?.(totalPushed);
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
    await this.ensureWatermarksLoaded();

    this.reportPhase('fetching-snapshot', 'Fetching latest snapshot…');
    const snapshot = await this.transport.getLatestSnapshot();
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
      // Clear derived tables as well as the operation log so the next catch-up
      // rebuilds everything from a clean baseline.
      await this.client.mutate('resetDerivedState', []);
      await this.client.mutate('clearOperationLog', []);
      this.lastReceivedHlc = { physical: 0, logical: 0 };
      this.lastPushedHlc = { physical: 0, logical: 0 };
      await this.saveWatermark(this.lastReceivedHlc, 'received');
      await this.saveWatermark(this.lastPushedHlc, 'pushed');
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
      const restoredHlc = await this.client.mutate<{ physical: number; logical: number }>(
        'restoreSnapshot',
        [snapshot.data]
      );
      // The snapshot metadata HLC is the authoritative watermark the server used
      // when it created the snapshot. Some snapshots (e.g. uploaded after local
      // compaction or from clients that don't keep the operation log) report a
      // lower HLC from their operation table than their metadata claims. Using the
      // metadata HLC ensures we don't re-fetch and re-apply the entire log.
      this.lastReceivedHlc = maxHlc(restoredHlc, snapshot.hlc);
      await this.saveWatermark(this.lastReceivedHlc, 'received');
    }

    // Paginate through all server pages. This keeps the sync logic simple and
    // lets us apply the full batch in sorted order. Memory use is modest:
    // 115k envelopes is a few megabytes of JSON.
    log.info('pull catching up', {
      afterHlc: this.lastReceivedHlc,
    });
    const envelopes = await this.transport.catchUp(this.lastReceivedHlc, (_page, totalSoFar) => {
      this.reportPhase('catching-up', `Catching up with server… ${totalSoFar} operations`);
      this.callbacks.onPullProgress?.({ applied: 0, total: totalSoFar });
    });
    log.info('pull catch-up result', { envelopeCount: envelopes.length });

    envelopes.sort((a, b) => {
      const cmp = compareHlc(a.hlc, b.hlc);
      if (cmp !== 0) return cmp;
      return a.id.localeCompare(b.id);
    });

    const workspaceId = await this.client.query<string>('getWorkspaceId', []);
    const ops = envelopes.map((env) =>
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

    // Apply the full batch in the worker. The worker runs off the main thread,
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

    // Detect semantic conflicts between the remote operations we just applied
    // and any local operations that are still pending (not yet acknowledged).
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

    const previousReceivedHlc = this.lastReceivedHlc;
    for (const op of ops) {
      this.lastReceivedHlc = maxHlc(this.lastReceivedHlc, op.envelope.hlc);
    }

    await this.saveWatermark(this.lastReceivedHlc, 'received');
    await this.saveRestoreEpoch(snapshot.restoreEpoch);
    // Flush the SQLite DB to IndexedDB so the watermark and operation log survive
    // a page reload. Large catch-ups need an immediate flush because a lot of state
    // changed. Tiny catch-ups (e.g. one remote edit) do not need to block the UI
    // with a 100+ MB IndexedDB write right now; the debounced scheduler will flush
    // the watermark and the single applied operation within a few hundred ms.
    const hlcAdvanced = compareHlc(this.lastReceivedHlc, previousReceivedHlc) > 0;
    if (envelopes.length > 10) {
      await this.client.mutate('persistNow', []);
    } else if (envelopes.length > 0 || hlcAdvanced) {
      await this.client.mutate('schedulePersist', []);
    }
    this.reportPhase('synced', 'Synced');
    this.callbacks.onPull?.(envelopes.length);

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
      const serverSnapshot = await this.transport.getLatestSnapshot();
      const localEpoch = await this.loadRestoreEpoch();
      const serverRestored = serverSnapshot.restoreEpoch !== localEpoch;

      if (serverRestored) {
        console.warn(
          `Server restore_epoch ${serverSnapshot.restoreEpoch} differs from local ${localEpoch}; ` +
            'skipping local push and rebuilding from server.'
        );
      } else {
        this.reportPhase('pushing-local', 'Sending local changes…');
        await this.push();
      }

      this.reportPhase('rebuilding-state', 'Rebuilding local state…');
      await this.client.mutate('resetDerivedState', []);
      await this.client.mutate('clearOperationLog', []);
      this.lastReceivedHlc = { physical: 0, logical: 0 };
      this.lastPushedHlc = { physical: 0, logical: 0 };
      await this.saveWatermark(this.lastReceivedHlc, 'received');
      await this.saveWatermark(this.lastPushedHlc, 'pushed');
      await this.saveRestoreEpoch(serverSnapshot.restoreEpoch);
      this.uploadedSnapshotHlc = null;
      this.reportPhase('pulling-operations', 'Pulling operations from server…');
      await this.pull({ ignoreSnapshot: true });
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
   * Reset received watermark to zero, clear the local operation log, and pull
   * everything from the server. Re-applying operations repairs derived state
   * that may have been produced by an older applier version.
   */
  async forceResync(): Promise<void> {
    await this.ensureWatermarksLoaded();

    await this.client.mutate('clearOperationLog', []);
    this.lastReceivedHlc = { physical: 0, logical: 0 };
    this.lastPushedHlc = { physical: 0, logical: 0 };
    await this.saveWatermark(this.lastReceivedHlc, 'received');
    await this.saveWatermark(this.lastPushedHlc, 'pushed');
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
