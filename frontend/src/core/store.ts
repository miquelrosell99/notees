import { type Database } from 'sql.js';
import { Clock } from './clock';
import { type TextCrdt } from './crdt/text';
import { createSchema } from './db/schema';
import { queryAll, queryOne, transaction } from './db/sqlite';
import { applyNodeOperation } from './derived/node';
import { applyChildOrderOperation } from './derived/childOrder';
import { applyPropertyOperation } from './derived/property';
import { getBacklinks, rebuildEdgesForNode } from './derived/edge';
import { loadTextCrdt, loadTreeCrdt, saveTreeCrdt } from './derived/crdtState';
import { createOperation, type Operation } from './types/operation';

export class WorkspaceStore {
  private clock: Clock;
  private db: Database;
  private workspaceId: string;
  private actorId: string;

  constructor(db: Database, workspaceId: string, actorId: string) {
    this.db = db;
    this.workspaceId = workspaceId;
    this.actorId = actorId;
    createSchema(db);
    this.clock = new Clock(actorId);
  }

  apply(op: Operation): void {
    const existing = queryOne<{ '1': number }>(this.db, 'SELECT 1 FROM operation WHERE id = ?', [op.envelope.id]);
    if (existing) return;

    const db = this.db;
    transaction(db, () => {
      db.run(
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
      applyNodeOperation(db, op);
      applyChildOrderOperation(db, op);
      applyPropertyOperation(db, op);
      const payload = op.payload as Record<string, unknown>;
      if (payload?.nodeId) {
        rebuildEdgesForNode(db, payload.nodeId as string);
      }
    });
  }

  createNode(args: {
    nodeId: string;
    kind: 'page' | 'block' | 'class';
    parentId: string | null;
    classIds?: string[];
  }): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [args.nodeId],
        opType: 'node.create',
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
        opType: 'node.updateContent',
      },
      { nodeId, textUpdate: Array.from(text.getState()) }
    );
    this.apply(op);
  }

  moveNode(nodeId: string, newParentId: string | null): void {
    const oldParentRow = queryOne<{ parent_id: string | null }>(
      this.db,
      'SELECT parent_id FROM node WHERE id = ?',
      [nodeId]
    );
    const oldParentId = oldParentRow?.parent_id ?? null;

    if (oldParentId !== null) {
      const oldTree = loadTreeCrdt(this.db, oldParentId);
      oldTree.delete(nodeId);
      saveTreeCrdt(this.db, oldParentId, oldTree);
      const oldUpdateOp = createOperation(
        {
          workspaceId: this.workspaceId,
          actorId: this.actorId,
          hlc: this.clock.advance(Date.now()),
          affectedNodeIds: [oldParentId],
          opType: 'node.updateContent',
        },
        { nodeId: oldParentId, treeUpdate: Array.from(oldTree.getState()) }
      );
      this.apply(oldUpdateOp);
    }

    if (newParentId !== null) {
      const newTree = loadTreeCrdt(this.db, newParentId);
      newTree.insert(nodeId, newTree.toArray().length);
      saveTreeCrdt(this.db, newParentId, newTree);
      const newUpdateOp = createOperation(
        {
          workspaceId: this.workspaceId,
          actorId: this.actorId,
          hlc: this.clock.advance(Date.now()),
          affectedNodeIds: [newParentId],
          opType: 'node.updateContent',
        },
        { nodeId: newParentId, treeUpdate: Array.from(newTree.getState()) }
      );
      this.apply(newUpdateOp);
    }

    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [nodeId, newParentId].filter(Boolean) as string[],
        opType: 'node.move',
      },
      { nodeId, newParentId }
    );
    this.apply(op);
  }

  deleteNode(nodeId: string): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [nodeId],
        opType: 'node.delete',
      },
      { nodeId }
    );
    this.apply(op);
  }

  setProperty(args: {
    propertyValueId: string;
    nodeId: string;
    schemaId: string;
    index?: number;
    value: unknown;
  }): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [args.nodeId],
        opType: 'property.set',
      },
      {
        propertyValueId: args.propertyValueId,
        nodeId: args.nodeId,
        schemaId: args.schemaId,
        index: args.index ?? 0,
        value: args.value,
      }
    );
    this.apply(op);
  }

  unsetProperty(args: { nodeId: string; schemaId: string; index?: number }): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [args.nodeId],
        opType: 'property.unset',
      },
      { nodeId: args.nodeId, schemaId: args.schemaId, index: args.index ?? 0 }
    );
    this.apply(op);
  }

  getNode(id: string): { kind: string; content: string } | undefined {
    return queryOne<{ kind: string; content: string }>(this.db, 'SELECT kind, content FROM node WHERE id = ?', [id]);
  }

  getBacklinks(nodeId: string): string[] {
    return getBacklinks(this.db, nodeId);
  }

  getChildren(parentId: string): string[] {
    const rows = queryAll<{ child_id: string }>(
      this.db,
      'SELECT child_id FROM node_child_order WHERE parent_id = ? ORDER BY position',
      [parentId]
    );
    return rows.map((r) => r.child_id);
  }

  getProperty(args: { nodeId: string; schemaId: string; index?: number }): { value: string } | undefined {
    return queryOne<{ value: string }>(
      this.db,
      'SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = ?',
      [args.nodeId, args.schemaId, args.index ?? 0]
    );
  }

  getDb(): Database {
    return this.db;
  }

  getWorkspaceId(): string {
    return this.workspaceId;
  }
}
