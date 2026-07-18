import { compareHlc, maxHlc, type Hlc } from './clock';
import { decryptEnvelope, encryptEnvelope } from './crypto';
import { queryAll, queryOne } from './db/sqlite';
import { createOperation, type Operation } from './types/operation';
import type { WorkspaceStore } from './store';
import type { Transport } from './transport';

export type SyncStatus = 'idle' | 'syncing' | 'error';

export interface SyncEngineCallbacks {
  onPush?: (envelopeCount: number) => void;
  onPull?: (envelopeCount: number) => void;
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
  private store: WorkspaceStore;
  private key: CryptoKey;
  private transport: Transport;
  private callbacks: SyncEngineCallbacks;
  private status: SyncStatus = 'idle';
  private lastError: Error | null = null;
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
  private statusListeners = new Set<(status: SyncStatus, error: Error | null) => void>();

  constructor(store: WorkspaceStore, key: CryptoKey, transport: Transport, callbacks: SyncEngineCallbacks = {}) {
    this.store = store;
    this.key = key;
    this.transport = transport;
    this.callbacks = callbacks;
    this.lastReceivedHlc = this.loadWatermark();
  }

  private loadWatermark(): Hlc {
    const db = this.store.getDb();
    const workspaceId = this.store.getWorkspaceId();
    const row = queryOne<{ hlc_physical: number; hlc_logical: number }>(
      db,
      'SELECT hlc_physical, hlc_logical FROM sync_watermark WHERE workspace_id = ?',
      [workspaceId]
    );
    return row ? { physical: row.hlc_physical, logical: row.hlc_logical } : { physical: 0, logical: 0 };
  }

  private saveWatermark(hlc: Hlc): void {
    const db = this.store.getDb();
    const workspaceId = this.store.getWorkspaceId();
    db.run(
      `INSERT INTO sync_watermark (workspace_id, hlc_physical, hlc_logical)
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
    const db = this.store.getDb();
    const rows = queryAll<OperationRow>(
      db,
      'SELECT * FROM operation ORDER BY hlc_physical ASC, hlc_logical ASC'
    );
    for (const row of rows) {
      const op: Operation = {
        envelope: {
          id: row.id,
          workspaceId: row.workspace_id,
          actorId: row.actor_id,
          hlc: { physical: row.hlc_physical, logical: row.hlc_logical },
          affectedNodeIds: JSON.parse(row.affected_node_ids),
          opType: row.op_type,
        },
        payload: JSON.parse(row.payload),
      };
      const encrypted = await encryptEnvelope(op.payload, this.key, {
        id: op.envelope.id,
        actorId: op.envelope.actorId,
        affectedNodeIds: op.envelope.affectedNodeIds,
        opType: op.envelope.opType,
        hlc: op.envelope.hlc,
      });
      await this.transport.send(encrypted);
    }
    this.callbacks.onPush?.(rows.length);
  }

  async pull(): Promise<void> {
    const envelopes = await this.transport.catchUp(this.lastReceivedHlc);
    envelopes.sort((a, b) => {
      const cmp = compareHlc(a.hlc, b.hlc);
      if (cmp !== 0) return cmp;
      return a.id.localeCompare(b.id);
    });
    for (const env of envelopes) {
      const payload = await decryptEnvelope(env, this.key);
      const op = createOperation(
        {
          id: env.id,
          workspaceId: this.store.getWorkspaceId(),
          actorId: env.actorId,
          hlc: env.hlc,
          affectedNodeIds: env.affectedNodeIds,
          opType: env.opType,
        },
        payload
      );
      this.store.apply(op);
      this.lastReceivedHlc = maxHlc(this.lastReceivedHlc, env.hlc);
    }
    this.saveWatermark(this.lastReceivedHlc);
    this.callbacks.onPull?.(envelopes.length);
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
