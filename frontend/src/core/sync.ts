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
    const BATCH_SIZE = 100;
    const db = this.store.getDb();
    const rows = queryAll<OperationRow>(
      db,
      `SELECT * FROM operation
       WHERE workspace_id = ?
         AND (hlc_physical > ? OR (hlc_physical = ? AND hlc_logical > ?))
       ORDER BY hlc_physical ASC, hlc_logical ASC`,
      [
        this.store.getWorkspaceId(),
        this.lastPushedHlc.physical,
        this.lastPushedHlc.physical,
        this.lastPushedHlc.logical,
      ]
    );

    const toEnvelope = (row: OperationRow) => ({
      id: row.id,
      workspaceId: this.store.getWorkspaceId(),
      actorId: row.actor_id,
      hlc: { physical: row.hlc_physical, logical: row.hlc_logical },
      affectedNodeIds: JSON.parse(row.affected_node_ids),
      opType: row.op_type,
      payload: JSON.parse(row.payload),
    });

    let pushedMaxHlc = this.lastPushedHlc;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE).map(toEnvelope);
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

    this.callbacks.onPush?.(rows.length);
  }

  async pull(): Promise<void> {
    // Try to restore from the latest server snapshot first. If the snapshot is
    // newer than our local watermark, we replace the derived DB with it and then
    // only replay operations newer than the snapshot.
    const snapshot = await this.transport.getLatestSnapshot();
    const snapshotIsNewer =
      snapshot && compareHlc(snapshot.hlc, this.lastReceivedHlc) > 0;

    if (snapshotIsNewer && snapshot) {
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

    // Apply in chunks so the progress overlay updates and the event loop stays
    // responsive. A chunk size of 5000 keeps transactions large enough to be
    // efficient but small enough to yield regularly.
    const CHUNK_SIZE = 5000;
    let applied = 0;
    for (let i = 0; i < ops.length; i += CHUNK_SIZE) {
      const chunk = ops.slice(i, i + CHUNK_SIZE);
      this.store.applyMany(chunk);
      applied += chunk.length;
      this.callbacks.onPullProgress?.({ applied, total: ops.length });
      if (i + CHUNK_SIZE < ops.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }

    for (const op of ops) {
      this.lastReceivedHlc = maxHlc(this.lastReceivedHlc, op.envelope.hlc);
    }

    this.saveWatermark(this.lastReceivedHlc, 'received');
    this.callbacks.onPull?.(envelopes.length);

    // Upload a snapshot when the server has no snapshot or an older one.
    // This helps the next device open quickly. Keep it best-effort.
    const uploadSnapshot = this.transport.uploadSnapshot;
    const shouldUploadSnapshot =
      uploadSnapshot &&
      (!snapshot || compareHlc(this.lastReceivedHlc, snapshot.hlc) > 0) &&
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

  /** Reset received watermark to zero and pull everything from the server. */
  async forceResync(): Promise<void> {
    this.lastReceivedHlc = { physical: 0, logical: 0 };
    this.saveWatermark(this.lastReceivedHlc, 'received');
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
