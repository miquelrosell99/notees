import { type Database } from 'sql.js';
import { Clock, compareHlc, type Hlc } from './clock';
import { type TextCrdt } from './crdt/text';
import { createSchema } from './db/schema';
import { queryAll, queryOne, transaction } from './db/sqlite';
import { applyOperation, type ChangeNotification } from './derived';
import { rebuildNodeStats } from './derived/nodeStats';
import { getBacklinks, rebuildEdgesForNode } from './derived/edge';
import { healNodeLinkTarget } from './derived/linkHealing';
import { getNodeVersions, getNodeVersionContent } from './query/versions';
import { rewriteLinksToTarget } from './query/mergePages';
import { loadTextCrdt, loadTreeCrdt, loadTreeCrdtClean, saveTreeCrdt } from './derived/crdtState';
import {
  createOperation,
  PROTOCOL_VERSION,
  type ClassCreatePayload,
  type ClassDeletePayload,
  type ClassPropertyEdgeCreatePayload,
  type ClassPropertyEdgeDeletePayload,
  type ClassPropertyEdgeReorderPayload,
  type ClassPropertyEdgeUpdatePayload,
  type ClassSetExtendsPayload,
  type ClassUpdatePayload,
  type NodeViewCreatePayload,
  type NodeViewDeletePayload,
  type NodeViewReorderPayload,
  type NodeViewUpdatePayload,
  type Operation,
  type PropertySchemaCreatePayload,
  type PropertySchemaDeletePayload,
  type PropertySchemaUpdatePayload,
} from './types/operation';
import type { OperationRow } from './sync';
import { uuidv7 } from './uuid';
import type { NotifyScope, NotifyChangeMessage } from './worker/workerProtocol';
import { createEmptyQueryAST } from '@/types/queryAST';
import { createDatabase } from './db/connection';

export interface NodeRow {
  id: string;
  workspaceId: string;
  kind: 'page' | 'block';
  parentId: string | null;
  classIds: string[];
  content: string;
  icon: string | null;
  color: string | null;
  active: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
}

export interface WorkspaceStoreOptions {
  /** Called with the exported database bytes after local mutations. */
  onPersist?: (data: Uint8Array) => void | Promise<void>;
  /** Called with a change notification after each applied operation batch. */
  onNotify?: (notification: NotifyChangeMessage) => void;
  /** Interval in ms to debounce persistence; defaults to 500. */
  persistDebounceMs?: number;
}

const DEFAULT_VIEW_NAMES: Record<string, string> = {
  child_pages: 'Child Pages',
  linked_references: 'Linked References',
  unlinked_references: 'Unlinked References',
  classed_nodes: 'Classed Nodes',
  extended_by: 'Extended By',
  main_content: 'Main Content',
  all_pages: 'All Pages',
};

/**
 * Bumps whenever client-side applier logic changes in a way that could leave
 * derived SQLite state inconsistent with the immutable operation log. Opening
 * a workspace with a stale version triggers a hard rebuild: derived tables are
 * cleared and the full server operation log is replayed with the new applier.
 */
export const CURRENT_DERIVED_STATE_VERSION = 4;

export class WorkspaceStore {
  private clock: Clock;
  private db: Database;
  private workspaceId: string;
  private actorId: string;
  private listeners = new Map<string, Set<(notification?: NotifyChangeMessage) => void>>();
  private allListeners = new Set<(notification?: NotifyChangeMessage) => void>();
  private onPersist?: (data: Uint8Array) => void | Promise<void>;
  private onNotify?: (notification: NotifyChangeMessage) => void;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistDebounceMs: number;
  private batchDepth = 0;
  private batchDirty = false;

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
    this.onNotify = options.onNotify;
    this.persistDebounceMs = options.persistDebounceMs ?? 500;
    createSchema(db);

    // New empty databases do not need a rebuild; mark them current immediately.
    if (!this.getDerivedStateVersion()) {
      const anyOp = queryOne<{ '1': number }>(
        db,
        'SELECT 1 FROM operation WHERE workspace_id = ? LIMIT 1',
        [workspaceId]
      );
      if (!anyOp) {
        this.setDerivedStateVersion(CURRENT_DERIVED_STATE_VERSION);
      }
    }

    this.clock = new Clock(actorId);
    this.initializeClockFromOperationLog();
    this.backfillOutboxForLocalOperations();
  }

  /**
   * Seed the local clock from the highest HLC already stored in the operation log.
   * This ensures that local edits made after loading a persisted workspace are
   * causally after every previously applied operation, even if the wall clock has
   * moved backwards or the client was offline for a long time.
   */
  private initializeClockFromOperationLog(): void {
    const row = queryOne<{ hlc_physical: number; hlc_logical: number }>(
      this.db,
      `SELECT hlc_physical, hlc_logical FROM operation
       WHERE workspace_id = ?
       ORDER BY hlc_physical DESC, hlc_logical DESC
       LIMIT 1`,
      [this.workspaceId]
    );
    if (row) {
      this.clock.update({ physical: row.hlc_physical, logical: row.hlc_logical }, Date.now());
    }
  }

  /**
   * Backfill pending outbox entries for local operations created before the
   * sync_outbox table existed. This ensures offline edits made by earlier
   * versions are still pushed once the new sync engine starts.
   */
  private backfillOutboxForLocalOperations(): void {
    this.db.run(
      `INSERT OR IGNORE INTO sync_outbox (operation_id, state, attempt_count, created_at, updated_at)
       SELECT id, 'pending', 0, timestamp, timestamp
       FROM operation
       WHERE workspace_id = ? AND actor_id = ?`,
      [this.workspaceId, this.actorId]
    );
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
      const data = this.export();
      void this.onPersist?.(new Uint8Array(data));
    }, this.persistDebounceMs);
  }

  /** Immediately persist the database if a callback is configured. */
  persistNow(): void {
    if (!this.onPersist) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    void this.onPersist(new Uint8Array(this.export()));
  }

  /**
   * Begin a batch of operations. While the batch is open, listeners are not
   * notified and persistence is deferred. This prevents the UI from re-rendering
   * on every operation during a large sync or import. Call `endBatch()` when the
   * batch is complete to emit a single collective notification and schedule
   * persistence.
   */
  startBatch(): void {
    this.batchDepth++;
  }

  /**
   * End a batch started with `startBatch()`. If any operations were applied
   * during the batch, all listeners are notified once and persistence is
   * scheduled.
   */
  endBatch(): void {
    this.batchDepth--;
    if (this.batchDepth === 0 && this.batchDirty) {
      this.batchDirty = false;
      this.emitAll();
      this.schedulePersist();
    }
  }

  /**
   * Clear the local operation log and sync watermarks so the next sync
   * re-downloads and re-applies all server operations. Derived tables are left
   * in place because the appliers are idempotent; re-applying will repair any
   * derived state that was produced by a buggy applier version.
   */
  clearOperationLog(): void {
    transaction(this.db, () => {
      this.db.run('DELETE FROM operation');
      this.db.run('DELETE FROM sync_watermark');
      this.db.run('DELETE FROM sync_push_watermark');
      this.db.run('DELETE FROM sync_outbox');
    });
    this.schedulePersist();
  }

  getDerivedStateVersion(): number {
    const row = queryOne<{ value: string }>(
      this.db,
      "SELECT value FROM app_meta WHERE key = 'derived_state_version'"
    );
    if (!row?.value) return 0;
    const parsed = parseInt(row.value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  setDerivedStateVersion(version: number): void {
    this.db.run(
      `INSERT INTO app_meta (key, value) VALUES ('derived_state_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [String(version)]
    );
  }

  isDerivedStateStale(): boolean {
    return this.getDerivedStateVersion() < CURRENT_DERIVED_STATE_VERSION;
  }

  /**
   * Clear all derived tables and local snapshots. Preserves the immutable
   * operation log so pending local changes can be pushed before a full replay.
   * Call this when the derived-state applier version changes; a subsequent
   * sync will re-download operations and rebuild derived tables with the new
   * applier. Snapshots are deleted because they may have been produced by an
   * older applier.
   */
  resetDerivedState(): void {
    transaction(this.db, () => {
      this.db.run('DELETE FROM node');
      this.db.run('DELETE FROM node_child_order');
      this.db.run('DELETE FROM property_value');
      this.db.run('DELETE FROM property_value_tombstone');
      this.db.run('DELETE FROM edge');
      this.db.run('DELETE FROM node_link');
      this.db.run('DELETE FROM crdt_state');
      this.db.run('DELETE FROM class_hierarchy');
      this.db.run('DELETE FROM property_schema');
      this.db.run('DELETE FROM class_property_edge');
      this.db.run('DELETE FROM search_index');
      this.db.run('DELETE FROM node_asset');
      this.db.run('DELETE FROM task_completion');
      this.db.run('DELETE FROM task_recurrence');
      this.db.run('DELETE FROM activity_log');
      this.db.run('DELETE FROM link_click');
      this.db.run('DELETE FROM node_public_share');
      this.db.run('DELETE FROM node_user_share');
      this.db.run('DELETE FROM plugin_op_log');
      this.db.run('DELETE FROM node_alias');
      this.db.run('DELETE FROM node_version');
      this.db.run('DELETE FROM node_view');
      this.db.run('DELETE FROM user_favorite');

      this.db.run('DELETE FROM snapshot');
      this.db.run('DELETE FROM compacted_operation_segment');

      this.setDerivedStateVersion(CURRENT_DERIVED_STATE_VERSION);
    });
    this.emitAll();
    this.schedulePersist();
  }

  apply(op: Operation): void {
    this.applyMany([op]);
  }

  /** Deduplicate and emit a batch of change notifications to subscribers. */
  private emitNotifications(notifications: ChangeNotification[]): void {
    if (notifications.length === 0) return;

    // Deduplicate by (scope, nodeId) while preserving order. relatedIds are
    // merged so listeners see the union of affected ids.
    const seen = new Map<string, ChangeNotification>();
    for (const n of notifications) {
      const key = `${n.scope}:${n.nodeId ?? ''}`;
      const existing = seen.get(key);
      if (existing) {
        if (n.relatedIds) {
          const merged = new Set([...(existing.relatedIds ?? []), ...n.relatedIds]);
          existing.relatedIds = Array.from(merged);
        }
      } else {
        seen.set(key, { ...n });
      }
    }

    for (const n of seen.values()) {
      this.notify(n.nodeId ?? '', n.scope, n.relatedIds);
    }
  }

  /**
   * Apply multiple operations in a single SQLite transaction.
   *
   * This is dramatically faster than calling ``apply()`` in a loop because it
   * avoids one transaction per operation, batches edge rebuilds, batches
   * listener notifications, and persists to IndexedDB only once at the end.
   *
   * Returns the count of newly applied operations plus the change notifications
   * produced so callers (e.g. the Web Worker) can forward them across threads.
   */
  applyMany(ops: Operation[]): { appliedCount: number; notifications: ChangeNotification[] } {
    if (ops.length === 0) return { appliedCount: 0, notifications: [] };

    const db = this.db;
    const ids = ops.map((op) => op.envelope.id);
    const existingIds = new Set<string>();

    // Batch the duplicate check for small batches; fall back to individual
    // checks for very large batches to keep the SQL IN clause reasonable.
    if (ids.length <= 1000) {
      const placeholders = ids.map(() => '?').join(',');
      const rows = queryAll<{ id: string }>(
        db,
        `SELECT id FROM operation WHERE id IN (${placeholders})`,
        ids
      );
      for (const row of rows) {
        existingIds.add(row.id);
      }
    }

    const notifications: ChangeNotification[] = [];
    const affectedNodeIds = new Set<string>();
    const edgeRebuildNodeIds = new Set<string>();
    let appliedCount = 0;
    let maxAppliedHlc: Hlc | null = null;

    transaction(db, () => {
      for (const op of ops) {
        if (ids.length > 1000) {
          const existing = queryOne<{ '1': number }>(
            db,
            'SELECT 1 FROM operation WHERE id = ?',
            [op.envelope.id]
          );
          if (existing) continue;
        } else if (existingIds.has(op.envelope.id)) {
          continue;
        }

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

        if (op.envelope.actorId === this.actorId) {
          const now = new Date().toISOString();
          db.run(
            `INSERT OR IGNORE INTO sync_outbox (operation_id, state, attempt_count, created_at, updated_at)
             VALUES (?, 'pending', 0, ?, ?)`,
            [op.envelope.id, now, now]
          );
        }

        notifications.push(...applyOperation(db, op));

        if (maxAppliedHlc === null || compareHlc(op.envelope.hlc, maxAppliedHlc) > 0) {
          maxAppliedHlc = op.envelope.hlc;
        }

        for (const nodeId of op.envelope.affectedNodeIds) {
          affectedNodeIds.add(nodeId);
        }

        const payload = op.payload as Record<string, unknown>;
        if (typeof payload?.nodeId === 'string') {
          edgeRebuildNodeIds.add(payload.nodeId);
        }

        appliedCount++;
      }

      for (const nodeId of edgeRebuildNodeIds) {
        const affectedIds = rebuildEdgesForNode(db, nodeId);
        if (affectedIds.length > 0) {
          notifications.push({ scope: 'edge', nodeId, relatedIds: affectedIds.filter((id) => id !== nodeId) });
          for (const id of affectedIds) {
            affectedNodeIds.add(id);
          }
        }
      }

      rebuildNodeStats(db, Array.from(affectedNodeIds));
    });

    if (maxAppliedHlc !== null) {
      this.clock.update(maxAppliedHlc, Date.now());
    }

    if (appliedCount > 0) {
      this.emitNotifications(notifications);
      if (this.batchDepth === 0) {
        this.schedulePersist();
      }
    }

    return { appliedCount, notifications };
  }

  getPendingPushOperations(afterHlc: Hlc, limit: number, now: number): OperationRow[] {
    return queryAll<OperationRow>(
      this.db,
      `SELECT o.id, o.workspace_id, o.actor_id, o.hlc_physical, o.hlc_logical, o.affected_node_ids, o.op_type, o.payload
       FROM operation o
       JOIN sync_outbox ob ON ob.operation_id = o.id
       WHERE o.workspace_id = ?
         AND o.actor_id = ?
         AND (o.hlc_physical > ? OR (o.hlc_physical = ? AND o.hlc_logical > ?))
         AND ob.state IN ('pending','in_flight','failed')
         AND (ob.state != 'failed' OR ob.next_retry_at <= ?)
       ORDER BY o.hlc_physical ASC, o.hlc_logical ASC
       LIMIT ?`,
      [
        this.workspaceId,
        this.actorId,
        afterHlc.physical,
        afterHlc.physical,
        afterHlc.logical,
        now,
        limit,
      ]
    );
  }

  markOperationsInFlight(ids: string[]): void {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    transaction(this.db, () => {
      for (const id of ids) {
        this.db.run(
          `UPDATE sync_outbox
           SET state = 'in_flight',
               attempt_count = attempt_count + 1,
               next_retry_at = NULL,
               updated_at = ?
           WHERE operation_id = ?`,
          [now, id]
        );
      }
    });
  }

  markOperationsAcknowledged(ids: string[]): void {
    if (ids.length === 0) return;
    transaction(this.db, () => {
      for (const id of ids) {
        this.db.run(
          `UPDATE sync_outbox
           SET state = 'acknowledged',
               last_error = NULL,
               next_retry_at = NULL,
               updated_at = ?
           WHERE operation_id = ?`,
          [new Date().toISOString(), id]
        );
      }
    });
  }

  markOperationsFailed(ids: string[], error: string, nextRetryAt: number | null): void {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    const state = nextRetryAt === null ? 'quarantined' : 'failed';
    transaction(this.db, () => {
      for (const id of ids) {
        this.db.run(
          `UPDATE sync_outbox
           SET state = CASE WHEN state = 'acknowledged' THEN state ELSE ? END,
               last_error = CASE WHEN state = 'acknowledged' THEN last_error ELSE ? END,
               next_retry_at = CASE WHEN state = 'acknowledged' THEN next_retry_at ELSE ? END,
               updated_at = CASE WHEN state = 'acknowledged' THEN updated_at ELSE ? END
           WHERE operation_id = ?`,
          [state, error, nextRetryAt, now, id]
        );
      }
    });
  }

  getOutboxAttemptCounts(ids: string[]): Record<string, number> {
    if (ids.length === 0) return {};
    const placeholders = ids.map(() => '?').join(',');
    const rows = queryAll<{ operation_id: string; attempt_count: number }>(
      this.db,
      `SELECT operation_id, attempt_count FROM sync_outbox WHERE operation_id IN (${placeholders})`,
      ids
    );
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.operation_id] = row.attempt_count;
    }
    return result;
  }

  /**
   * Return local operations that are not yet acknowledged by the server and that
   * affect any of the given node ids. Used by the sync engine to detect semantic
   * conflicts between remote operations and local pending edits.
   */
  getPendingLocalOperations(nodeIds: string[]): Operation[] {
    if (nodeIds.length === 0) return [];
    const nodeIdSet = new Set(nodeIds);
    const rows = queryAll<OperationRow>(
      this.db,
      `SELECT o.id, o.workspace_id, o.actor_id, o.hlc_physical, o.hlc_logical, o.affected_node_ids, o.op_type, o.payload
       FROM operation o
       JOIN sync_outbox ob ON ob.operation_id = o.id
       WHERE o.workspace_id = ? AND o.actor_id = ? AND ob.state != 'acknowledged'`,
      [this.workspaceId, this.actorId]
    );
    const ops: Operation[] = [];
    for (const row of rows) {
      const affectedNodeIds = JSON.parse(row.affected_node_ids) as string[];
      if (!affectedNodeIds.some((id) => nodeIdSet.has(id))) continue;
      ops.push({
        envelope: {
          id: row.id,
          protocolVersion: PROTOCOL_VERSION,
          workspaceId: row.workspace_id,
          actorId: row.actor_id,
          hlc: { physical: row.hlc_physical, logical: row.hlc_logical },
          affectedNodeIds,
          opType: row.op_type,
        },
        payload: JSON.parse(row.payload) as unknown,
      });
    }
    return ops;
  }

  subscribe(
    nodeId: string,
    callback: ((notification?: NotifyChangeMessage) => void) | (() => void)
  ): () => void {
    let set = this.listeners.get(nodeId);
    if (!set) {
      set = new Set();
      this.listeners.set(nodeId, set);
    }
    set.add(callback as (notification?: NotifyChangeMessage) => void);
    return () => {
      set?.delete(callback as (notification?: NotifyChangeMessage) => void);
      if (set?.size === 0) {
        this.listeners.delete(nodeId);
      }
    };
  }

  /**
   * Subscribe to every store change. Used by collection hooks (classes, node
   * lists, search) that cannot enumerate the individual node ids they depend on.
   */
  subscribeAll(
    callback: ((notification?: NotifyChangeMessage) => void) | (() => void)
  ): () => void {
    this.allListeners.add(callback as (notification?: NotifyChangeMessage) => void);
    return () => {
      this.allListeners.delete(callback as (notification?: NotifyChangeMessage) => void);
    };
  }

  private notify(nodeId: string, scope: NotifyScope = 'node', relatedIds?: string[]): void {
    if (this.batchDepth > 0) {
      this.batchDirty = true;
      return;
    }
    const message: NotifyChangeMessage = { type: 'notify', nodeId, scope, relatedIds };
    this.onNotify?.(message);

    const set = this.listeners.get(nodeId);
    if (set) {
      for (const callback of set) {
        try {
          callback(message);
        } catch (err) {
          // Listener errors should not break store operations.
          console.error('WorkspaceStore listener error:', err);
        }
      }
    }
    for (const callback of this.allListeners) {
      try {
        callback(message);
      } catch (err) {
        console.error('WorkspaceStore listener error:', err);
      }
    }
  }

  private emitAll(): void {
    if (this.batchDepth > 0) {
      this.batchDirty = true;
      return;
    }
    const message: NotifyChangeMessage = { type: 'notify', scope: 'all' };
    this.onNotify?.(message);
    for (const callback of this.allListeners) {
      try {
        callback(message);
      } catch (err) {
        console.error('WorkspaceStore listener error:', err);
      }
    }
  }

  getFavorites(): string[] {
    const rows = queryAll<{ node_id: string }>(
      this.db,
      'SELECT node_id FROM user_favorite WHERE actor_id = ? AND workspace_id = ? ORDER BY position ASC',
      [this.actorId, this.workspaceId]
    );
    return rows.map((r) => r.node_id);
  }

  createNode(args: {
    nodeId: string;
    kind: 'page' | 'block';
    parentId: string | null;
    classIds?: string[];
    icon?: string | null;
    color?: string | null;
  }): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [args.nodeId],
        opType: 'node.create',
      },
      {
        nodeId: args.nodeId,
        kind: args.kind,
        parentId: args.parentId,
        classIds: args.classIds ?? [],
        icon: args.icon ?? null,
        color: args.color ?? null,
      }
    );
    this.apply(op);
  }

  private applyTextUpdate(nodeId: string, text: TextCrdt): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [nodeId],
        opType: 'node.updateContent',
      },
      // The text CRDT plaintext is the serialized content AST; mirror it in
      // `content` so non-CRDT clients can read node content without decoding
      // the Yjs update.
      { nodeId, textUpdate: Array.from(text.getState()), content: text.toPlaintext() }
    );
    this.apply(op);
  }

  updateText(nodeId: string, editor: (text: TextCrdt) => void): void {
    const text = loadTextCrdt(this.db, nodeId);
    editor(text);
    this.applyTextUpdate(nodeId, text);
  }

  /**
   * Replace the entire text content of a node with a plain string.
   * Serializable worker-compatible alternative to updateText callbacks.
   */
  setNodeText(nodeId: string, value: string): void {
    const text = loadTextCrdt(this.db, nodeId);
    const current = text.toPlaintext();
    text.delete(0, current.length);
    text.insert(0, value);
    this.applyTextUpdate(nodeId, text);
  }

  /**
   * Insert plain text at the given index in a node's text CRDT.
   * Serializable worker-compatible alternative to updateText callbacks.
   */
  insertNodeText(nodeId: string, index: number, value: string): void {
    const text = loadTextCrdt(this.db, nodeId);
    text.insert(index, value);
    this.applyTextUpdate(nodeId, text);
  }

  /**
   * Delete a range of text from a node's text CRDT.
   * Serializable worker-compatible alternative to updateText callbacks.
   */
  deleteNodeText(nodeId: string, index: number, length: number): void {
    const text = loadTextCrdt(this.db, nodeId);
    text.delete(index, length);
    this.applyTextUpdate(nodeId, text);
  }

  /**
   * Replace a node's content AST directly. Used by maintenance tools that need
   * to perform structural AST transformations (e.g. converting raw [[uuid]]
   * text into node_link nodes) without going through the text CRDT.
   */
  updateContentAst(nodeId: string, content: unknown[]): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [nodeId],
        opType: 'node.updateContent',
      },
      { nodeId, content }
    );
    this.apply(op);
  }

  updateNodeIcon(nodeId: string, icon: string | null): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [nodeId],
        opType: 'node.updateIcon',
      },
      { nodeId, icon }
    );
    this.apply(op);
  }

  updateNodeColor(nodeId: string, color: string | null): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [nodeId],
        opType: 'node.updateColor',
      },
      { nodeId, color }
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
      const oldTree = loadTreeCrdtClean(this.db, oldParentId);
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
      const newTree = loadTreeCrdtClean(this.db, newParentId);
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

  archiveNode(nodeId: string): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [nodeId],
        opType: 'node.archive',
      },
      { nodeId }
    );
    this.apply(op);
  }

  restoreNode(nodeId: string): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [nodeId],
        opType: 'node.restore',
      },
      { nodeId }
    );
    this.apply(op);
  }

  permanentDeleteNode(nodeId: string): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [nodeId],
        opType: 'node.permanentDelete',
      },
      { nodeId }
    );
    this.apply(op);
  }

  addFavorite(nodeId: string): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [nodeId],
        opType: 'user.favorite.add',
      },
      { nodeId }
    );
    this.apply(op);
  }

  removeFavorite(nodeId: string): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [nodeId],
        opType: 'user.favorite.remove',
      },
      { nodeId }
    );
    this.apply(op);
  }

  reorderFavorites(nodeIds: string[]): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: nodeIds,
        opType: 'user.favorite.reorder',
      },
      { nodeIds }
    );
    this.apply(op);
  }

  convertNode(args: {
    nodeId: string;
    kind: 'page' | 'block';
    parentId?: string | null;
    classIds?: string[];
  }): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [args.nodeId, args.parentId].filter((id): id is string => !!id),
        opType: 'node.convert',
      },
      {
        nodeId: args.nodeId,
        kind: args.kind,
        parentId: args.parentId ?? null,
        classIds: args.classIds ?? [],
      }
    );
    this.apply(op);
  }

  createClass(args: ClassCreatePayload): void {
    const payload: ClassCreatePayload = {
      classId: args.classId,
      name: args.name,
    };
    if (args.icon !== undefined) payload.icon = args.icon;
    if (args.color !== undefined) payload.color = args.color;
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [args.classId],
        opType: 'class.create',
      },
      payload
    );
    this.apply(op);
  }

  updateClass(args: ClassUpdatePayload): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [args.classId],
        opType: 'class.update',
      },
      args
    );
    this.apply(op);
  }

  deleteClass(classId: string): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [classId],
        opType: 'class.delete',
      },
      { classId } satisfies ClassDeletePayload
    );
    this.apply(op);
  }

  setClassExtends(args: ClassSetExtendsPayload): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [args.classId, ...args.extendsClassIds],
        opType: 'class.setExtends',
      },
      args
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

  createPropertySchema(
    args: Omit<PropertySchemaCreatePayload, 'schemaId'> & { schemaId?: string }
  ): string {
    const schemaId = args.schemaId ?? uuidv7();
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [schemaId],
        opType: 'propertySchema.create',
      },
      { ...args, schemaId }
    );
    this.apply(op);
    return schemaId;
  }

  updatePropertySchema(args: PropertySchemaUpdatePayload): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [args.schemaId],
        opType: 'propertySchema.update',
      },
      args
    );
    this.apply(op);
  }

  deletePropertySchema(schemaId: string): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [schemaId],
        opType: 'propertySchema.delete',
      },
      { schemaId } satisfies PropertySchemaDeletePayload
    );
    this.apply(op);
  }

  addPropertyToClass(args: ClassPropertyEdgeCreatePayload): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [args.classId, args.propertySchemaId],
        opType: 'classPropertyEdge.create',
      },
      args
    );
    this.apply(op);
  }

  updateClassProperty(args: ClassPropertyEdgeUpdatePayload): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [args.classId, args.propertySchemaId],
        opType: 'classPropertyEdge.update',
      },
      args
    );
    this.apply(op);
  }

  removePropertyFromClass(args: ClassPropertyEdgeDeletePayload): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [args.classId, args.propertySchemaId],
        opType: 'classPropertyEdge.delete',
      },
      args
    );
    this.apply(op);
  }

  reorderClassProperties(args: ClassPropertyEdgeReorderPayload): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [args.classId, ...args.orderedPropertySchemaIds],
        opType: 'classPropertyEdge.reorder',
      },
      args
    );
    this.apply(op);
  }

  createNodeView(args: Omit<NodeViewCreatePayload, 'viewId'> & { viewId?: string }): string {
    const viewId = args.viewId ?? uuidv7();
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [args.nodeId, viewId],
        opType: 'nodeView.create',
      },
      { ...args, viewId } satisfies NodeViewCreatePayload
    );
    this.apply(op);
    return viewId;
  }

  updateNodeView(args: NodeViewUpdatePayload): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [args.viewId],
        opType: 'nodeView.update',
      },
      args
    );
    this.apply(op);
  }

  deleteNodeView(viewId: string): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [viewId],
        opType: 'nodeView.delete',
      },
      { viewId } satisfies NodeViewDeletePayload
    );
    this.apply(op);
  }

  reorderNodeViews(args: NodeViewReorderPayload): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [args.nodeId, ...args.orderedViewIds],
        opType: 'nodeView.reorder',
      },
      args
    );
    this.apply(op);
  }

  ensureDefaultNodeViews(nodeId: string, viewTypes: string[]): string[] {
    const existingTypes = new Set(
      queryAll<{ view_type: string }>(
        this.db,
        'SELECT view_type FROM node_view WHERE node_id = ? AND active = 1',
        [nodeId]
      ).map((r) => r.view_type)
    );

    const created: string[] = [];
    for (const viewType of viewTypes) {
      if (existingTypes.has(viewType)) continue;

      const maxOrderRow = queryOne<{ max_order: number | null }>(
        this.db,
        'SELECT MAX(order_index) AS max_order FROM node_view WHERE node_id = ? AND view_type = ? AND active = 1',
        [nodeId, viewType]
      );
      const orderIndex = (maxOrderRow?.max_order ?? -1) + 1;

      const viewId = this.createNodeView({
        nodeId,
        name: DEFAULT_VIEW_NAMES[viewType] ?? viewType,
        viewType,
        orderIndex,
        isDefault: true,
        queryAst: createEmptyQueryAST(),
      });
      created.push(viewId);
      existingTypes.add(viewType);
    }
    return created;
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
      kind: 'page' | 'block';
      parentId: string | null;
      classIds: string;
      content: string;
      icon: string | null;
      color: string | null;
      active: number;
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
         icon,
         color,
         active,
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
      active: row.active !== 0,
      classIds: JSON.parse(row.classIds) as string[],
    };
  }

  getBacklinks(nodeId: string): string[] {
    return getBacklinks(this.db, nodeId);
  }

  /**
   * Resolve the canonical target UUID for a link instance and optionally heal
   * the source node's AST if the cached target UUID has drifted from the
   * canonical ``node_link.target_id``.
   *
   * Returns the canonical target UUID (or the AST target if no link row exists).
   */
  resolveAndHealNodeLink(sourceNodeId: string, linkId: string): string | null {
    const result = healNodeLinkTarget(this.db, sourceNodeId, linkId, { heal: true });
    if (result.healed && result.newAst) {
      this.updateContentAst(sourceNodeId, result.newAst as unknown[]);
    }
    return result.canonicalTargetUuid;
  }

  getChildren(parentId: string): string[] {
    const rows = queryAll<{ child_id: string }>(
      this.db,
      'SELECT child_id FROM node_child_order WHERE parent_id = ? ORDER BY position',
      [parentId]
    );
    return rows.map((r) => r.child_id);
  }

  /**
   * Batch fetch children for multiple parent nodes in a single query.
   * Returns a map from parent_id to ordered child ids.
   */
  getChildrenBatch(parentIds: string[]): Record<string, string[]> {
    if (parentIds.length === 0) return {};
    const placeholders = parentIds.map(() => '?').join(',');
    const rows = queryAll<{ parent_id: string; child_id: string }>(
      this.db,
      `SELECT parent_id, child_id FROM node_child_order WHERE parent_id IN (${placeholders}) ORDER BY position`,
      parentIds
    );
    const result: Record<string, string[]> = {};
    for (const parentId of parentIds) {
      result[parentId] = [];
    }
    for (const row of rows) {
      result[row.parent_id].push(row.child_id);
    }
    return result;
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

  addAlias(canonicalNodeId: string, aliasNodeId: string): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [canonicalNodeId, aliasNodeId],
        opType: 'node.addAlias',
      },
      { canonicalNodeId, aliasNodeId }
    );
    this.apply(op);
  }

  removeAlias(canonicalNodeId: string, aliasNodeId: string): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [canonicalNodeId, aliasNodeId],
        opType: 'node.removeAlias',
      },
      { canonicalNodeId, aliasNodeId }
    );
    this.apply(op);
  }

  getNodeVersions(nodeId: string, limit?: number): ReturnType<typeof getNodeVersions> {
    return getNodeVersions(this, nodeId, limit);
  }

  restoreNodeVersion(nodeId: string, versionId: string): void {
    const content = getNodeVersionContent(this, nodeId, versionId);
    if (!content) throw new Error(`Version ${versionId} not found for node ${nodeId}`);

    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [nodeId],
        opType: 'node.updateContent',
      },
      { nodeId, content }
    );
    this.apply(op);
  }

  mergePages(sourceId: string, targetId: string): void {
    if (sourceId === targetId) throw new Error('Cannot merge a page into itself');

    // Move all children from source to target.
    const children = this.getChildren(sourceId);
    for (const childId of children) {
      this.moveNode(childId, targetId);
    }

    // Rewrite backlinks so references to source point to target.
    rewriteLinksToTarget(this, sourceId, targetId);

    // Archive the source page.
    this.archiveNode(sourceId);
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

  getActorId(): string {
    return this.actorId;
  }

  /**
   * Return the derived asset metadata for a node, or undefined when the node
   * is not an asset. Written by the ``asset.upload`` applier; read by the
   * local-mode asset store to resolve content hashes without a server call.
   */
  getAssetInfo(nodeId: string):
    | { assetHash: string; mimeType: string; sizeBytes: number; originalName: string }
    | undefined {
    const row = queryOne<{
      asset_hash: string;
      mime_type: string;
      size: number;
      original_name: string;
    }>(this.db, 'SELECT asset_hash, mime_type, size, original_name FROM node_asset WHERE node_id = ?', [
      nodeId,
    ]);
    if (!row) return undefined;
    return {
      assetHash: row.asset_hash,
      mimeType: row.mime_type,
      sizeBytes: row.size,
      originalName: row.original_name,
    };
  }

  /**
   * Return every operation in this workspace's local op log, ordered by HLC
   * (causal order; rowid breaks cross-actor ties by insertion order). Used by
   * connect-later adoption (local-first split, Task 6) to replay the FULL log —
   * not just the outbox — into a fresh, empty server workspace.
   */
  getAllOperations(): Operation[] {
    const rows = queryAll<OperationRow>(
      this.db,
      `SELECT id, workspace_id, actor_id, hlc_physical, hlc_logical, affected_node_ids, op_type, payload
       FROM operation
       WHERE workspace_id = ?
       ORDER BY hlc_physical ASC, hlc_logical ASC, rowid ASC`,
      [this.workspaceId]
    );
    return rows.map((row) => ({
      envelope: {
        id: row.id,
        protocolVersion: PROTOCOL_VERSION,
        workspaceId: row.workspace_id,
        actorId: row.actor_id,
        hlc: { physical: row.hlc_physical, logical: row.hlc_logical },
        affectedNodeIds: JSON.parse(row.affected_node_ids) as string[],
        opType: row.op_type,
      },
      payload: JSON.parse(row.payload) as unknown,
    }));
  }

  /**
   * Return every derived asset row (asset node → content-addressed blob
   * metadata). Written by the `asset.upload` applier; rows for deleted assets
   * are removed by `asset.delete`, so this is the live inventory. Used by
   * connect-later adoption to upload locally stored blobs to the server.
   */
  getAllAssets(): Array<{
    nodeId: string;
    assetHash: string;
    mimeType: string;
    sizeBytes: number;
    originalName: string;
  }> {
    const rows = queryAll<{
      node_id: string;
      asset_hash: string;
      mime_type: string;
      size: number;
      original_name: string;
    }>(this.db, 'SELECT node_id, asset_hash, mime_type, size, original_name FROM node_asset');
    return rows.map((row) => ({
      nodeId: row.node_id,
      assetHash: row.asset_hash,
      mimeType: row.mime_type,
      sizeBytes: row.size,
      originalName: row.original_name,
    }));
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

  /** Export the current derived state as a snapshot blob without persisting it. */
  exportSnapshot(upToHlc?: { physical: number; logical: number }): {
    id: string;
    hlc: { physical: number; logical: number };
    data: Uint8Array;
  } {
    const hlc = upToHlc ?? this.getLatestHlc();
    const id = uuidv7();
    const data = this.export();
    return { id, hlc, data };
  }

  /** Restore the latest local snapshot and return its HLC. */
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
    this.emitAll();
    return { physical: row.hlc_physical, logical: row.hlc_logical };
  }

  /** Restore from an arbitrary snapshot blob and return its HLC. */
  async restoreSnapshot(data: Uint8Array): Promise<{ physical: number; logical: number }> {
    this.db = await createDatabase(data);
    // Ensure the schema is present in case the snapshot predates a schema change.
    createSchema(this.db);
    // Older server snapshots were generated before the frontend enforced a
    // PRIMARY KEY on node_child_order, so they may contain duplicate
    // (parent_id, child_id) rows. Re-create the table with the correct primary
    // key and ignore duplicates so the snapshot can be loaded.
    this.db.run(`
      CREATE TABLE node_child_order_dedup (
        parent_id TEXT NOT NULL,
        child_id TEXT NOT NULL,
        position TEXT NOT NULL,
        PRIMARY KEY (parent_id, child_id)
      );
      INSERT OR IGNORE INTO node_child_order_dedup
        SELECT parent_id, child_id, position FROM node_child_order;
      DROP TABLE node_child_order;
      ALTER TABLE node_child_order_dedup RENAME TO node_child_order;
    `);
    this.emitAll();
    return this.getLatestHlc();
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
