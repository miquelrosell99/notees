import type { WorkspaceStore } from "./store";
import type { MemoryRelay } from "./relay";
import type { EncryptedEnvelope } from "./crypto";
import { decryptEnvelope, encryptEnvelope } from "./crypto";
import type { Operation } from "./operation";
import { createOperation } from "./operation";
import type { Database } from "bun:sqlite";
import { maxHlc, type Hlc } from "./clock";

export class SyncEngine {
  private lastReceivedHlc: Hlc = { physical: 0, logical: 0 };

  constructor(
    private store: WorkspaceStore,
    private actorId: string,
    private key: CryptoKey
  ) {}

  async pushTo(relay: MemoryRelay): Promise<void> {
    const db = (this.store as any).db as Database;
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
    const workspaceId = (this.store as any).workspaceId as string;
    const envelopes = relay.catchUp(workspaceId, this.lastReceivedHlc);
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
  }
}
