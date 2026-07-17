import { Database } from "bun:sqlite";
import { Clock } from "./clock";
import { TextCrdt } from "./crdt/text";
import { createSchema } from "./db";
import { applyNodeOperation } from "./derived/node";
import { applyChildOrderOperation } from "./derived/childOrder";
import { applyPropertyOperation } from "./derived/property";
import { rebuildEdgesForNode } from "./derived/edge";
import { loadTextCrdt } from "./derived/crdtState";
import { createOperation, type Operation } from "./operation";

export class WorkspaceStore {
  private clock: Clock;

  constructor(
    private db: Database,
    private workspaceId: string,
    private actorId: string
  ) {
    createSchema(db);
    this.clock = new Clock(actorId);
  }

  apply(op: Operation): void {
    const existing = this.db
      .query("SELECT 1 FROM operation WHERE id = ?")
      .get(op.envelope.id);
    if (existing) return;

    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO operation (id, workspace_id, actor_id, hlc_physical, hlc_logical, affected_node_ids, op_type, payload, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          op.envelope.id,
          op.envelope.workspaceId,
          op.envelope.actorId,
          op.envelope.hlc.physical,
          op.envelope.hlc.logical,
          JSON.stringify(op.envelope.affectedNodeIds),
          op.envelope.opType,
          JSON.stringify(op.payload),
          new Date().toISOString(),
        ]
      );
      applyNodeOperation(this.db, op);
      applyChildOrderOperation(this.db, op);
      applyPropertyOperation(this.db, op);
      const payload = op.payload as any;
      if (payload?.nodeId) {
        rebuildEdgesForNode(this.db, payload.nodeId);
      }
    })();
  }

  createNode(args: { nodeId: string; kind: "page" | "block" | "class"; parentId: string | null; classIds?: string[] }): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [args.nodeId],
        opType: "node.create",
      },
      { nodeId: args.nodeId, kind: args.kind, parentId: args.parentId, classIds: args.classIds ?? [] }
    );
    this.apply(op);
  }

  updateText(nodeId: string, editor: (text: TextCrdt) => void): void {
    const text = loadTextCrdt(this.db, nodeId);
    editor(text);
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [nodeId],
        opType: "node.updateContent",
      },
      { nodeId, textUpdate: Array.from(text.getState()) }
    );
    this.apply(op);
  }

  moveNode(nodeId: string, newParentId: string | null): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [nodeId, newParentId].filter(Boolean) as string[],
        opType: "node.move",
      },
      { nodeId, newParentId }
    );
    this.apply(op);
  }

  setProperty(args: { propertyValueId: string; nodeId: string; schemaId: string; index?: number; value: unknown }): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [args.nodeId],
        opType: "property.set",
      },
      { propertyValueId: args.propertyValueId, nodeId: args.nodeId, schemaId: args.schemaId, index: args.index ?? 0, value: args.value }
    );
    this.apply(op);
  }

  getNode(id: string): { kind: string; content: string } {
    return this.db.query("SELECT kind, content FROM node WHERE id = ?").get(id) as { kind: string; content: string };
  }
}
