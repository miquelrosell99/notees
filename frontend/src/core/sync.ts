import { compareHlc, maxHlc, type Hlc } from './clock';
import { queryAll, queryOne } from './db/sqlite';
import { createOperation } from './types/operation';
import type { WorkspaceStore } from './store';
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

interface OperationRow {
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
  private lastReceivedHlc: Hlc;
  private lastPushedHlc: Hlc;
  private store: WorkspaceStore;
  private transport: Transport;
  private callbacks: SyncEngineCallbacks;
  private status: SyncStatus = 'idle';
  private lastError: Error | null = null;
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
  private statusListeners = new Set<(status: SyncStatus, error: Error | null) => void>();
  /** HLC of the last snapshot we uploaded this session; avoid re-uploading. */
  private uploadedSnapshotHlc: Hlc | null = null;

  constructor(store: WorkspaceStore, transport: Transport, callbacks: SyncEngineCallbacks = {}) {
    this.store = store;
    this.transport = transport;
    this.callbacks = callbacks;
    this.lastReceivedHlc = this.loadWatermark('received');
    this.lastPushedHlc = this.loadWatermark('pushed');
  }

  private loadWatermark(kind: 'received' | 'pushed'): Hlc {
    const db = this.store.getDb();
    const workspaceId = this.store.getWorkspaceId();
    const table = kind === 'received' ? 'sync_watermark' : 'sync_push_watermark';
    const row = queryOne<{ hlc_physical: number; hlc_logical: number }>(
      db,
      `SELECT hlc_physical, hlc_logical FROM ${table} WHERE workspace_id = ?`,
      [workspaceId]
    );
    return row ? { physical: row.hlc_physical, logical: row.hlc_logical } : { physical: 0, logical: 0 };
  }

  private saveWatermark(hlc: Hlc, kind: 'received' | 'pushed'): void {
    const db = this.store.getDb();
    const workspaceId = this.store.getWorkspaceId();
    const table = kind === 'received' ? 'sync_watermark' : 'sync_push_watermark';
    db.run(
      `INSERT INTO ${table} (workspace_id, hlc_physical, hlc_logical)
       VALUES (?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         hlc_physical = excluded.hlc_physical,
         hlc_logical = excluded.hlc_logical`,
      [workspaceId, hlc.physical, hlc.logical]
    );
  }

  private loadRestoreEpoch(): number {
    const db = this.store.getDb();
    const workspaceId = this.store.getWorkspaceId();
    const row = queryOne<{ restore_epoch: number }>(
      db,
      'SELECT restore_epoch FROM sync_watermark WHERE workspace_id = ?',
      [workspaceId]
    );
    return row?.restore_epoch ?? 0;
  }

  private saveRestoreEpoch(epoch: number): void {
    const db = this.store.getDb();
    const workspaceId = this.store.getWorkspaceId();
    db.run(
      `INSERT INTO sync_watermark (workspace_id, hlc_physical, hlc_logical, restore_epoch)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         restore_epoch = excluded.restore_epoch`,
      [workspaceId, this.lastReceivedHlc.physical, this.lastReceivedHlc.logical, epoch]
    );
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
    const SEND_BATCH_SIZE = 100;
    const QUERY_BATCH_SIZE = 1000;
    const db = this.store.getDb();
    const workspaceId = this.store.getWorkspaceId();
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
      const rows = queryAll<OperationRow>(
        db,
        `SELECT * FROM operation
         WHERE workspace_id = ?
           AND (hlc_physical > ? OR (hlc_physical = ? AND hlc_logical > ?))
         ORDER BY hlc_physical ASC, hlc_logical ASC
         LIMIT ?`,
        [
          workspaceId,
          this.lastPushedHlc.physical,
          this.lastPushedHlc.physical,
          this.lastPushedHlc.logical,
          QUERY_BATCH_SIZE,
        ]
      );

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
        this.saveWatermark(this.lastPushedHlc, 'pushed');
      }

      // Yield so the UI can process input events between query chunks.
      if (hasMore) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }

    this.callbacks.onPush?.(totalPushed);
  }

  async pull(options: { ignoreSnapshot?: boolean; applyChunkSize?: number } = {}): Promise<void> {
    const snapshot = await this.transport.getLatestSnapshot();
    const localEpoch = this.loadRestoreEpoch();

    // If the server was restored or rebuilt, clear local state and start over.
    // The operation log is the source of truth; re-applying all operations from
    // the restored server converges to the correct state.
    if (snapshot.restoreEpoch !== localEpoch) {
      this.store.clearOperationLog();
      this.lastReceivedHlc = { physical: 0, logical: 0 };
      this.lastPushedHlc = { physical: 0, logical: 0 };
      this.saveWatermark(this.lastReceivedHlc, 'received');
      this.saveWatermark(this.lastPushedHlc, 'pushed');
      this.saveRestoreEpoch(snapshot.restoreEpoch);
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
      await this.store.restoreSnapshot(snapshot.data);
      this.lastReceivedHlc = snapshot.hlc;
      this.saveWatermark(this.lastReceivedHlc, 'received');
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

    const ops = envelopes.map((env) =>
      createOperation(
        {
          id: env.id,
          workspaceId: this.store.getWorkspaceId(),
          actorId: env.actorId,
          hlc: env.hlc,
          affectedNodeIds: env.affectedNodeIds,
          opType: env.opType,
        },
        env.payload
      )
    );

    // Apply in chunks so the progress overlay updates and the browser can paint.
    // A chunk size of 500 keeps each synchronous block small enough that the UI
    // stays responsive (hover, scroll, animation) even with 100k+ operations.
    // During a hard rebuild the UI is intentionally blocked by a progress overlay,
    // so we can use a larger chunk size to finish faster.
    const CHUNK_SIZE = options.applyChunkSize ?? 500;
    let applied = 0;
    for (let i = 0; i < ops.length; i += CHUNK_SIZE) {
      const chunk = ops.slice(i, i + CHUNK_SIZE);
      this.store.applyMany(chunk);
      applied += chunk.length;
      this.callbacks.onPullProgress?.({ applied, total: ops.length });
      // Yield so the browser can paint and process input events before the next
      // chunk. setTimeout(0) is cheaper than requestAnimationFrame for bulk work
      // while still letting the event loop handle hover/scroll/animation frames.
      if (i + CHUNK_SIZE < ops.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }

    for (const op of ops) {
      this.lastReceivedHlc = maxHlc(this.lastReceivedHlc, op.envelope.hlc);
    }

    this.saveWatermark(this.lastReceivedHlc, 'received');
    this.saveRestoreEpoch(snapshot.restoreEpoch);
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
        const { hlc, data } = this.store.exportSnapshot(this.lastReceivedHlc);
        await uploadSnapshot({
          snapshotId: '',
          workspaceId: this.store.getWorkspaceId(),
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
    if (!this.store.isDerivedStateStale()) {
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
      const localEpoch = this.loadRestoreEpoch();
      const serverRestored = serverSnapshot.restoreEpoch !== localEpoch;

      if (serverRestored) {
        console.warn(
          `Server restore_epoch ${serverSnapshot.restoreEpoch} differs from local ${localEpoch}; ` +
            'skipping local push and rebuilding from server.'
        );
      } else {
        await this.push();
      }

      this.store.resetDerivedState();
      this.store.clearOperationLog();
      this.lastReceivedHlc = { physical: 0, logical: 0 };
      this.lastPushedHlc = { physical: 0, logical: 0 };
      this.saveWatermark(this.lastReceivedHlc, 'received');
      this.saveWatermark(this.lastPushedHlc, 'pushed');
      this.saveRestoreEpoch(serverSnapshot.restoreEpoch);
      this.uploadedSnapshotHlc = null;
      await this.pull({ ignoreSnapshot: true, applyChunkSize: 2000 });
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
    this.store.clearOperationLog();
    this.lastReceivedHlc = { physical: 0, logical: 0 };
    this.lastPushedHlc = { physical: 0, logical: 0 };
    this.saveWatermark(this.lastReceivedHlc, 'received');
    this.saveWatermark(this.lastPushedHlc, 'pushed');
    this.uploadedSnapshotHlc = null;
    await this.syncOnce();
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
