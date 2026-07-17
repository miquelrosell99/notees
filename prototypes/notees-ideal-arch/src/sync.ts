import type { WorkspaceStore } from "./store";
import type { MemoryRelay } from "./relay";
import { decryptEnvelope, encryptEnvelope } from "./crypto";
import type { Operation } from "./operation";
import { createOperation } from "./operation";
import { compareHlc, maxHlc, type Hlc } from "./clock";

export class SyncEngine {
  private lastReceivedHlc: Hlc;

  constructor(
    private store: WorkspaceStore,
    private actorId: string,
    private key: CryptoKey
  ) {
    this.lastReceivedHlc = this.loadWatermark();
  }

  private loadWatermark(): Hlc {
    const db = this.store.getDb();
    const workspaceId = this.store.getWorkspaceId();
    const row = db
      .query("SELECT hlc_physical, hlc_logical FROM sync_watermark WHERE workspace_id = ?")
      .get(workspaceId) as { hlc_physical: number; hlc_logical: number } | undefined;
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

  async pushTo(relay: MemoryRelay): Promise<void> {
    const db = this.store.getDb();
    const rows = db
      .query("SELECT * FROM operation ORDER BY hlc_physical ASC, hlc_logical ASC")
      .all() as any[];
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
      relay.send(row.workspace_id, encrypted);
    }
  }

  async pullFrom(relay: MemoryRelay): Promise<void> {
    const workspaceId = this.store.getWorkspaceId();
    const envelopes = relay.catchUp(workspaceId, this.lastReceivedHlc);
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
          workspaceId,
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
}
