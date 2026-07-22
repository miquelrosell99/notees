import { compareHlc, maxHlc, type Hlc } from './clock';
import { createOperation } from './types/operation';
import type { IWorkspaceStoreClient } from './worker/workerProtocol';
import type { Transport } from './transport';

export type SyncStatus = 'idle' | 'syncing' | 'error';

export interface SyncPullProgress {
  applied: number;
  total: number;
}

export interface SyncEngineCallbacks {
  onPush?: (envelopeCount: number) => void;
  onPull?: (envelopeCount: number) => void;
  onPullProgress?: (progress: SyncPullProgress) => void;
  onError?: (error: Error) => void;
  onStatusChange?: (status: SyncStatus, error: Error | null) => void;
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
  /** HLC of the last snapshot we uploaded this session; avoid re-uploading. */
  private uploadedSnapshotHlc: Hlc | null = null;
  private watermarksLoaded = false;

  constructor(client: IWorkspaceStoreClient, transport: Transport, callbacks: SyncEngineCallbacks = {}) {
    this.client = client;
    this.transport = transport;
    this.callbacks = callbacks;
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

  async push(): Promise<void> {
    await this.ensureWatermarksLoaded();

    const SEND_BATCH_SIZE = 100;
    const QUERY_BATCH_SIZE = 1000;
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

    let pushedMaxHlc = this.lastPushedHlc;
    let totalPushed = 0;
    let hasMore = true;

    // Query and push in smaller chunks so a large local operation log does not
    // block the main thread with a single huge SELECT *. Recompute the HLC
    // params each iteration because lastPushedHlc advances after every chunk.
    while (hasMore) {
      const rows = await this.client.query<OperationRow[]>('queryOperationLog', [
        this.lastPushedHlc,
        QUERY_BATCH_SIZE,
      ]);

      hasMore = rows.length === QUERY_BATCH_SIZE;
      totalPushed += rows.length;

      for (let i = 0; i < rows.length; i += SEND_BATCH_SIZE) {
        const chunk = rows.slice(i, i + SEND_BATCH_SIZE).map(toEnvelope);
        if (this.transport.sendBatch) {
          await this.transport.sendBatch(chunk);
        } else {
          for (const envelope of chunk) {
            await this.transport.send(envelope);
          }
        }
        for (const envelope of chunk) {
          pushedMaxHlc = maxHlc(pushedMaxHlc, envelope.hlc);
        }
        this.lastPushedHlc = pushedMaxHlc;
        await this.saveWatermark(this.lastPushedHlc, 'pushed');
      }
    }

    this.callbacks.onPush?.(totalPushed);
  }

  async pull(options: { ignoreSnapshot?: boolean } = {}): Promise<void> {
    await this.ensureWatermarksLoaded();

    const snapshot = await this.transport.getLatestSnapshot();
    const localEpoch = await this.loadRestoreEpoch();

    // If the server was restored or rebuilt, clear local state and start over.
    // The operation log is the source of truth; re-applying all operations from
    // the restored server converges to the correct state.
    if (snapshot.restoreEpoch !== localEpoch) {
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

    if (snapshotIsNewer) {
      this.callbacks.onPullProgress?.({ applied: 0, total: 0 });
      const restoredHlc = await this.client.mutate<{ physical: number; logical: number }>(
        'restoreSnapshot',
        [snapshot.data]
      );
      this.lastReceivedHlc = restoredHlc;
      await this.saveWatermark(this.lastReceivedHlc, 'received');
    }

    // Paginate through all server pages. This keeps the sync logic simple and
    // lets us apply the full batch in sorted order. Memory use is modest:
    // 115k envelopes is a few megabytes of JSON.
    const envelopes = await this.transport.catchUp(this.lastReceivedHlc, (_page, totalSoFar) => {
      this.callbacks.onPullProgress?.({ applied: 0, total: totalSoFar });
    });

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
    await this.client.mutate('startBatch', []);
    try {
      const applied = await this.client.mutate<number>('applyMany', [ops]);
      this.callbacks.onPullProgress?.({ applied, total: ops.length });
    } finally {
      await this.client.mutate('endBatch', []);
    }

    for (const op of ops) {
      this.lastReceivedHlc = maxHlc(this.lastReceivedHlc, op.envelope.hlc);
    }

    await this.saveWatermark(this.lastReceivedHlc, 'received');
    await this.saveRestoreEpoch(snapshot.restoreEpoch);
    this.callbacks.onPull?.(envelopes.length);

    // Upload a snapshot when the server has no snapshot or an older one.
    // This helps the next device open quickly. Keep it best-effort.
    const uploadSnapshot = this.transport.uploadSnapshot;
    const shouldUploadSnapshot =
      uploadSnapshot &&
      (!snapshot.hasSnapshot || compareHlc(this.lastReceivedHlc, snapshot.hlc) > 0) &&
      (!this.uploadedSnapshotHlc ||
        compareHlc(this.lastReceivedHlc, this.uploadedSnapshotHlc) > 0);

    if (shouldUploadSnapshot && uploadSnapshot) {
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
      await this.syncOnce();
      return;
    }

    this.setStatus('syncing');
    try {
      // Fetch server restore metadata before deciding whether to push local ops.
      // If the server was restored, local state is stale by definition and we
      // must not push potentially stale local operations back upstream. In the
      // normal case (applier update only), preserve local offline edits by
      // pushing them first.
      const serverSnapshot = await this.transport.getLatestSnapshot();
      const localEpoch = await this.loadRestoreEpoch();
      const serverRestored = serverSnapshot.restoreEpoch !== localEpoch;

      if (serverRestored) {
        console.warn(
          `Server restore_epoch ${serverSnapshot.restoreEpoch} differs from local ${localEpoch}; ` +
            'skipping local push and rebuilding from server.'
        );
      } else {
        await this.push();
      }

      await this.client.mutate('resetDerivedState', []);
      await this.client.mutate('clearOperationLog', []);
      this.lastReceivedHlc = { physical: 0, logical: 0 };
      this.lastPushedHlc = { physical: 0, logical: 0 };
      await this.saveWatermark(this.lastReceivedHlc, 'received');
      await this.saveWatermark(this.lastPushedHlc, 'pushed');
      await this.saveRestoreEpoch(serverSnapshot.restoreEpoch);
      this.uploadedSnapshotHlc = null;
      await this.pull({ ignoreSnapshot: true });
      this.setStatus('idle', null);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.setStatus('error', error);
      this.callbacks.onError?.(error);
      throw error;
    }
  }

  async syncOnce(): Promise<void> {
    this.setStatus('syncing');
    try {
      await this.push();
      await this.pull();
      this.setStatus('idle', null);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.setStatus('error', error);
      this.callbacks.onError?.(error);
      throw error;
    }
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
