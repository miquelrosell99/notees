import { compareHlc, maxHlc, type Hlc } from './clock';
import { decryptEnvelope, encryptEnvelope } from './crypto';
import { queryAll, queryOne } from './db/sqlite';
import { createOperation, type Operation } from './types/operation';
import type { WorkspaceStore } from './store';
import type { Transport } from './transport';

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

  constructor(store: WorkspaceStore, key: CryptoKey, transport: Transport) {
    this.store = store;
    this.key = key;
    this.transport = transport;
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
  }

  async sync(): Promise<void> {
    await this.push();
    await this.pull();
  }
}
