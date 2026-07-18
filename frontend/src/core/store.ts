import { type Database } from 'sql.js';
import { Clock } from './clock';
import { type TextCrdt } from './crdt/text';
import { createSchema } from './db/schema';
import { queryAll, queryOne, transaction } from './db/sqlite';
import { applyNodeOperation } from './derived/node';
import { applyChildOrderOperation } from './derived/childOrder';
import { applyPropertyOperation } from './derived/property';
import { applyAssetOperation } from './derived/asset';
import { applyTaskOperation } from './derived/task';
import { applyActivityOperation } from './derived/activity';
import { applyLinkOperation } from './derived/link';
import { applyShareOperation } from './derived/share';
import { applyPluginOperation } from './derived/plugin';
import { getBacklinks, rebuildEdgesForNode } from './derived/edge';
import { loadTextCrdt, loadTreeCrdt, saveTreeCrdt } from './derived/crdtState';
import { createOperation, type Operation } from './types/operation';
import { uuidv7 } from './uuid';
import { createDatabase } from './db/connection';

export interface NodeRow {
  id: string;
  workspaceId: string;
  kind: 'page' | 'block' | 'class';
  parentId: string | null;
  classIds: string[];
  content: string;
  createdAt: string | null;
  updatedAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
}

export interface WorkspaceStoreOptions {
  /** Called with the exported database bytes after local mutations. */
  onPersist?: (data: Uint8Array) => void | Promise<void>;
  /** Interval in ms to debounce persistence; defaults to 500. */
  persistDebounceMs?: number;
}

export class WorkspaceStore {
  private clock: Clock;
  private db: Database;
  private workspaceId: string;
  private actorId: string;
  private listeners = new Map<string, Set<() => void>>();
  private onPersist?: (data: Uint8Array) => void | Promise<void>;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistDebounceMs: number;

  constructor(
    db: Database,
    workspaceId: string,
    actorId: string,
    options: WorkspaceStoreOptions = {}
  ) {
    this.db = db;
    this.workspaceId = workspaceId;
    this.actorId = actorId;
    this.onPersist = options.onPersist;
    this.persistDebounceMs = options.persistDebounceMs ?? 500;
    createSchema(db);
    this.clock = new Clock(actorId);
  }

  /** Export the whole database as a Uint8Array for persistence or snapshots. */
  export(): Uint8Array {
    return this.db.export();
  }

  /** Persist the database via the configured onPersist callback (debounced). */
  schedulePersist(): void {
    if (!this.onPersist) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.onPersist?.(this.export());
    }, this.persistDebounceMs);
  }

  /** Immediately persist the database if a callback is configured. */
  persistNow(): void {
    if (!this.onPersist) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    void this.onPersist(this.export());
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
      applyAssetOperation(db, op);
      applyTaskOperation(db, op);
      applyActivityOperation(db, op);
      applyLinkOperation(db, op);
      applyShareOperation(db, op);
      applyPluginOperation(db, op);
      const payload = op.payload as Record<string, unknown>;
      if (payload?.nodeId) {
        rebuildEdgesForNode(db, payload.nodeId as string);
      }
    });

    for (const nodeId of op.envelope.affectedNodeIds) {
      this.notify(nodeId);
    }

    this.schedulePersist();
  }

  subscribe(nodeId: string, callback: () => void): () => void {
    let set = this.listeners.get(nodeId);
    if (!set) {
      set = new Set();
      this.listeners.set(nodeId, set);
    }
    set.add(callback);
    return () => {
      set?.delete(callback);
      if (set?.size === 0) {
        this.listeners.delete(nodeId);
      }
    };
  }

  private notify(nodeId: string): void {
    const set = this.listeners.get(nodeId);
    if (!set) return;
    for (const callback of set) {
      try {
        callback();
      } catch (err) {
        // Listener errors should not break store operations.
        console.error('WorkspaceStore listener error:', err);
      }
    }
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

    if (oldParentId !== null) {
      this.notify(oldParentId);
    }
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

  getOrCreateNode(id: string, defaults: Partial<Omit<NodeRow, 'id'>> & { kind: NodeRow['kind'] }): NodeRow {
    const existing = this.getNode(id);
    if (existing) return existing;

    this.createNode({
      nodeId: id,
      kind: defaults.kind,
      parentId: defaults.parentId ?? null,
      classIds: defaults.classIds ?? [],
    });

    const created = this.getNode(id);
    if (!created) {
      throw new Error(`Failed to create node ${id}`);
    }
    return created;
  }

  getNode(id: string): NodeRow | undefined {
    const row = queryOne<{
      id: string;
      workspaceId: string;
      kind: 'page' | 'block' | 'class';
      parentId: string | null;
      classIds: string;
      content: string;
      createdAt: string | null;
      updatedAt: string | null;
      createdBy: string | null;
      updatedBy: string | null;
    }>(
      this.db,
      `SELECT
         id,
         workspace_id AS workspaceId,
         kind,
         parent_id AS parentId,
         class_ids AS classIds,
         content,
         created_at AS createdAt,
         updated_at AS updatedAt,
         created_by AS createdBy,
         updated_by AS updatedBy
       FROM node
       WHERE id = ?`,
      [id]
    );
    if (!row) return undefined;
    return {
      ...row,
      classIds: JSON.parse(row.classIds) as string[],
    };
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

  getProperties(nodeId: string): Array<{ propertyValueId: string; schemaId: string; index: number; value: unknown }> {
    const rows = queryAll<{
      id: string;
      property_schema_id: string;
      idx: number;
      value: string;
    }>(
      this.db,
      'SELECT id, property_schema_id, idx, value FROM property_value WHERE node_id = ? ORDER BY property_schema_id, idx',
      [nodeId]
    );
    return rows.map((row) => ({
      propertyValueId: row.id,
      schemaId: row.property_schema_id,
      index: row.idx,
      value: JSON.parse(row.value) as unknown,
    }));
  }

  getTextState(nodeId: string): Uint8Array {
    return loadTextCrdt(this.db, nodeId).getState();
  }

  getTreeState(parentId: string): Uint8Array {
    return loadTreeCrdt(this.db, parentId).getState();
  }

  assignClass(nodeId: string, classId: string): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [nodeId],
        opType: 'class.assign',
      },
      { nodeId, classId }
    );
    this.apply(op);
  }

  unassignClass(nodeId: string, classId: string): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [nodeId],
        opType: 'class.unassign',
      },
      { nodeId, classId }
    );
    this.apply(op);
  }

  getClock(): Clock {
    return this.clock;
  }

  getDb(): Database {
    return this.db;
  }

  getWorkspaceId(): string {
    return this.workspaceId;
  }

  /** Create a snapshot of the derived state up to the given HLC. */
  createSnapshot(upToHlc?: { physical: number; logical: number }): string {
    const hlc = upToHlc ?? this.getLatestHlc();
    const id = uuidv7();
    const data = this.export();
    const stateHash = this.computeStateHash(data);
    const db = this.db;
    db.run(
      `INSERT INTO snapshot (id, workspace_id, hlc_physical, hlc_logical, state_hash, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, this.workspaceId, hlc.physical, hlc.logical, stateHash, data, new Date().toISOString()]
    );
    return id;
  }

  /** Restore the latest snapshot and return its HLC so callers can replay newer ops. */
  async restoreLatestSnapshot(): Promise<{ physical: number; logical: number } | null> {
    const row = queryOne<{
      id: string;
      hlc_physical: number;
      hlc_logical: number;
      data: Uint8Array;
    }>(
      this.db,
      `SELECT id, hlc_physical, hlc_logical, data FROM snapshot
       WHERE workspace_id = ?
       ORDER BY hlc_physical DESC, hlc_logical DESC, created_at DESC
       LIMIT 1`,
      [this.workspaceId]
    );
    if (!row) return null;

    // Re-create the database from the snapshot bytes. This replaces the underlying
    // SQLite database while preserving the WorkspaceStore instance identity.
    this.db = await createDatabase(row.data);
    return { physical: row.hlc_physical, logical: row.hlc_logical };
  }

  /** Compact operations older than the given HLC and record a segment. */
  compactOperations(upToHlc: { physical: number; logical: number }): void {
    const db = this.db;
    const countRow = queryOne<{ count: number }>(
      db,
      `SELECT COUNT(*) AS count FROM operation
       WHERE workspace_id = ?
         AND (hlc_physical < ? OR (hlc_physical = ? AND hlc_logical <= ?))`,
      [this.workspaceId, upToHlc.physical, upToHlc.physical, upToHlc.logical]
    );
    const count = countRow?.count ?? 0;
    const segmentId = uuidv7();
    db.run(
      `INSERT INTO compacted_operation_segment (
         id, workspace_id, from_hlc_physical, from_hlc_logical,
         to_hlc_physical, to_hlc_logical, snapshot_id, operation_count, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        segmentId,
        this.workspaceId,
        0,
        0,
        upToHlc.physical,
        upToHlc.logical,
        '',
        count,
        new Date().toISOString(),
      ]
    );
    db.run(
      `DELETE FROM operation
       WHERE workspace_id = ?
         AND (hlc_physical < ? OR (hlc_physical = ? AND hlc_logical <= ?))`,
      [this.workspaceId, upToHlc.physical, upToHlc.physical, upToHlc.logical]
    );
  }

  private getLatestHlc(): { physical: number; logical: number } {
    const row = queryOne<{ hlc_physical: number; hlc_logical: number }>(
      this.db,
      `SELECT hlc_physical, hlc_logical FROM operation
       WHERE workspace_id = ?
       ORDER BY hlc_physical DESC, hlc_logical DESC
       LIMIT 1`,
      [this.workspaceId]
    );
    return row ? { physical: row.hlc_physical, logical: row.hlc_logical } : { physical: 0, logical: 0 };
  }

  private computeStateHash(data: Uint8Array): string {
    // Simple hash for snapshot integrity checks.
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      hash = (hash * 31 + data[i]) | 0;
    }
    return hash.toString(16);
  }
}
