/**
 * Workspace Web Worker
 *
 * Owns the sql.js Database and the real WorkspaceStore. All heavy work
 * (mutations, queries, sync apply, export) happens here, off the main thread.
 */

import { createDatabase } from '../db/connection';
import { WorkspaceStore } from '../store';
import { queryAll, queryOne } from '../db/sqlite';
import { queryNodes } from '../query/queryNodes';
import { executeQuery } from '../query/executeQuery';
import { projectNode } from '../adapters/nodeProjection';
import {
  getNodeProperties,
  getPropertySchemas,
  getBatchPropertyValues,
  getClassProperties,
  getNodeClassPropertyEdges,
} from '../adapters/propertyQueries';
import { UndoManager } from '../undo/UndoManager';
import type { Hlc } from '../clock';
import type { Operation } from '../types/operation';
import type { OperationRow } from '../sync';
import type { WorkerRequest, WorkerResponse, NotifyChangeMessage } from './workerProtocol';
import {
  getArchivedPages,
  getCommentNodes,
  getPageAliases,
  getTrashedNodes,
} from './queryHelpers';

interface WorkerState {
  store: WorkspaceStore | null;
  undoManager: UndoManager | null;
  workspaceId: string | null;
}

const state: WorkerState = {
  store: null,
  undoManager: null,
  workspaceId: null,
};

function postResponse(response: WorkerResponse): void {
  self.postMessage(response);
}

function postNotify(nodeId?: string): void {
  const msg: NotifyChangeMessage = { type: 'notify', nodeId };
  self.postMessage(msg);
}

async function handleInit(request: Extract<WorkerRequest, { type: 'init' }>): Promise<void> {
  if (state.store) {
    // Close existing store gracefully if re-initializing.
    state.store = null;
    state.undoManager = null;
    state.workspaceId = null;
  }

  const db = await createDatabase(request.dbBytes);
  const store = new WorkspaceStore(db, request.workspaceId, request.actorId, {
    onPersist: async (data) => {
      // M5 will send this back to the main thread for IndexedDB persistence.
      // For now the worker just holds the bytes; the main thread can poll via export.
      void data;
    },
  });

  state.store = store;
  state.undoManager = new UndoManager(store);
  state.workspaceId = request.workspaceId;

  postResponse({ type: 'init-done', id: request.id });
}

function handleExport(request: Extract<WorkerRequest, { type: 'export' }>): void {
  if (!state.store) {
    postResponse({ type: 'error', id: request.id, message: 'Store not initialized' });
    return;
  }
  const bytes = state.store.export();
  postResponse({ type: 'export-result', id: request.id, bytes });
}

async function handleMutate(request: Extract<WorkerRequest, { type: 'mutate' }>): Promise<void> {
  if (!state.store || !state.undoManager) {
    postResponse({ type: 'error', id: request.id, message: 'Store not initialized' });
    return;
  }

  const { method } = request;

  // Sync-engine helpers. These run directly on the worker-owned store.
  if (method === 'applyMany') {
    const [ops] = request.args as [Operation[]];
    const count = state.store.applyMany(ops);
    postResponse({ type: 'mutate-done', id: request.id, result: count });
    postNotify();
    return;
  }
  if (method === 'startBatch') {
    state.store.startBatch();
    postResponse({ type: 'mutate-done', id: request.id, result: undefined });
    return;
  }
  if (method === 'endBatch') {
    state.store.endBatch();
    postResponse({ type: 'mutate-done', id: request.id, result: undefined });
    postNotify();
    return;
  }
  if (method === 'restoreSnapshot') {
    const [data] = request.args as [Uint8Array];
    const hlc = await state.store.restoreSnapshot(data);
    postResponse({ type: 'mutate-done', id: request.id, result: hlc });
    postNotify();
    return;
  }
  if (method === 'clearOperationLog') {
    state.store.clearOperationLog();
    postResponse({ type: 'mutate-done', id: request.id, result: undefined });
    postNotify();
    return;
  }
  if (method === 'resetDerivedState') {
    state.store.resetDerivedState();
    postResponse({ type: 'mutate-done', id: request.id, result: undefined });
    postNotify();
    return;
  }
  if (method === 'saveWatermark') {
    const [kind, hlc] = request.args as ['received' | 'pushed', Hlc];
    saveWatermark(state.store, kind, hlc);
    postResponse({ type: 'mutate-done', id: request.id, result: undefined });
    return;
  }
  if (method === 'saveRestoreEpoch') {
    const [epoch, receivedHlc] = request.args as [number, Hlc];
    saveRestoreEpoch(state.store, epoch, receivedHlc);
    postResponse({ type: 'mutate-done', id: request.id, result: undefined });
    return;
  }

  // Undo-manager operations run on the worker-owned store and are addressed
  // through record-* method names so they can be serialized across the boundary.
  if (method === 'recordCreateNode') {
    const [args] = request.args as [Parameters<WorkspaceStore['createNode']>[0]];
    state.undoManager.createNode(args);
    postResponse({ type: 'mutate-done', id: request.id, result: undefined });
    postNotify();
    return;
  }
  if (method === 'recordCreateBlock') {
    const [args] = request.args as [(Parameters<WorkspaceStore['createNode']>[0] & { content?: string })];
    state.undoManager.createBlock(args);
    postResponse({ type: 'mutate-done', id: request.id, result: undefined });
    postNotify();
    return;
  }
  if (method === 'recordSetNodeText') {
    const [nodeId, value] = request.args as [string, string];
    state.undoManager.recordSetNodeText(nodeId, value);
    postResponse({ type: 'mutate-done', id: request.id, result: undefined });
    postNotify();
    return;
  }
  if (method === 'recordDeleteNode') {
    const [nodeId] = request.args as [string];
    state.undoManager.deleteNode(nodeId);
    postResponse({ type: 'mutate-done', id: request.id, result: undefined });
    postNotify();
    return;
  }
  if (method === 'recordMoveNode') {
    const [nodeId, newParentId] = request.args as [string, string | null];
    state.undoManager.moveNode(nodeId, newParentId);
    postResponse({ type: 'mutate-done', id: request.id, result: undefined });
    postNotify();
    return;
  }
  if (method === 'recordMergeBlocks') {
    const [sourceBlockId, targetBlockId] = request.args as [string, string];
    state.undoManager.mergeBlocks(sourceBlockId, targetBlockId);
    postResponse({ type: 'mutate-done', id: request.id, result: undefined });
    postNotify();
    return;
  }
  if (method === 'recordSetProperty') {
    const [args] = request.args as [Parameters<WorkspaceStore['setProperty']>[0]];
    state.undoManager.setProperty(args);
    postResponse({ type: 'mutate-done', id: request.id, result: undefined });
    postNotify();
    return;
  }
  if (method === 'recordUnsetProperty') {
    const [args] = request.args as [Parameters<WorkspaceStore['unsetProperty']>[0]];
    state.undoManager.unsetProperty(args);
    postResponse({ type: 'mutate-done', id: request.id, result: undefined });
    postNotify();
    return;
  }
  if (method === 'recordAssignClass') {
    const [nodeId, classId] = request.args as [string, string];
    state.undoManager.assignClass(nodeId, classId);
    postResponse({ type: 'mutate-done', id: request.id, result: undefined });
    postNotify();
    return;
  }
  if (method === 'recordUnassignClass') {
    const [nodeId, classId] = request.args as [string, string];
    state.undoManager.unassignClass(nodeId, classId);
    postResponse({ type: 'mutate-done', id: request.id, result: undefined });
    postNotify();
    return;
  }
  if (method === 'undo') {
    const entry = state.undoManager.undo();
    const result = entry ? { label: entry.label, timestamp: entry.timestamp } : null;
    postResponse({ type: 'mutate-done', id: request.id, result });
    postNotify();
    return;
  }
  if (method === 'redo') {
    const entry = state.undoManager.redo();
    const result = entry ? { label: entry.label, timestamp: entry.timestamp } : null;
    postResponse({ type: 'mutate-done', id: request.id, result });
    postNotify();
    return;
  }
  if (method === 'clearUndoHistory') {
    state.undoManager.clear();
    postResponse({ type: 'mutate-done', id: request.id, result: undefined });
    postNotify();
    return;
  }

  const storeMethod = (state.store as unknown as Record<string, unknown>)[request.method];
  if (typeof storeMethod !== 'function') {
    postResponse({
      type: 'error',
      id: request.id,
      message: `Unknown mutation method: ${request.method}`,
    });
    return;
  }
  const result = await (storeMethod as (...args: unknown[]) => unknown).apply(state.store, request.args);
  postResponse({ type: 'mutate-done', id: request.id, result });
  postNotify();
}

async function handleQuery(request: Extract<WorkerRequest, { type: 'query' }>): Promise<void> {
  if (!state.store) {
    postResponse({ type: 'error', id: request.id, message: 'Store not initialized' });
    return;
  }

  // Sync-engine query helpers.
  if (request.method === 'isDerivedStateStale') {
    postResponse({
      type: 'query-result',
      id: request.id,
      result: state.store.isDerivedStateStale(),
    });
    return;
  }
  if (request.method === 'loadWatermarks') {
    postResponse({ type: 'query-result', id: request.id, result: loadWatermarks(state.store) });
    return;
  }
  if (request.method === 'queryOperationLog') {
    const [afterHlc, limit] = request.args as [Hlc, number];
    postResponse({
      type: 'query-result',
      id: request.id,
      result: queryOperationLog(state.store, afterHlc, limit),
    });
    return;
  }
  if (request.method === 'getWorkspaceId') {
    postResponse({ type: 'query-result', id: request.id, result: state.store.getWorkspaceId() });
    return;
  }
  if (request.method === 'getActorId') {
    postResponse({ type: 'query-result', id: request.id, result: state.store.getActorId() });
    return;
  }
  if (request.method === 'exportSnapshot') {
    const [upToHlc] = request.args as [Hlc | undefined];
    const snapshot = state.store.exportSnapshot(upToHlc);
    postResponse({
      type: 'query-result',
      id: request.id,
      result: { hlc: snapshot.hlc, data: snapshot.data },
    });
    return;
  }

  // Undo-manager state queries are serviced by the worker-owned manager.
  if (request.method === 'canUndo') {
    const result = {
      canUndo: state.undoManager?.canUndo() ?? false,
      canRedo: state.undoManager?.canRedo() ?? false,
    };
    postResponse({ type: 'query-result', id: request.id, result });
    return;
  }

  if (request.method === 'getUndoStacks') {
    const stacks = state.undoManager?.getStacks() ?? { undo: [], redo: [] };
    const result = {
      undo: stacks.undo.map((entry) => ({ label: entry.label, timestamp: entry.timestamp })),
      redo: stacks.redo.map((entry) => ({ label: entry.label, timestamp: entry.timestamp })),
    };
    postResponse({ type: 'query-result', id: request.id, result });
    return;
  }

  // Special-case query helpers that are not methods on WorkspaceStore.
  if (request.method === 'queryNodes') {
    const result = queryNodes(state.store, request.args[0] as Parameters<typeof queryNodes>[1]);
    postResponse({ type: 'query-result', id: request.id, result });
    return;
  }

  if (request.method === 'executeQuery') {
    const result = executeQuery(state.store, request.args[0] as Parameters<typeof executeQuery>[1]);
    postResponse({ type: 'query-result', id: request.id, result });
    return;
  }

  if (request.method === 'projectNode') {
    const [nodeId, depth] = request.args as [string, number | undefined];
    const result = projectNode(state.store, nodeId, depth);
    postResponse({ type: 'query-result', id: request.id, result });
    return;
  }

  if (request.method === 'getNodeProperties') {
    const [nodeId] = request.args as [string];
    const result = getNodeProperties(state.store, nodeId);
    postResponse({ type: 'query-result', id: request.id, result });
    return;
  }

  if (request.method === 'getPropertySchemas') {
    const result = getPropertySchemas(state.store);
    postResponse({ type: 'query-result', id: request.id, result });
    return;
  }

  if (request.method === 'getBatchPropertyValues') {
    const [nodeUuids] = request.args as [string[]];
    const result = getBatchPropertyValues(state.store, nodeUuids);
    postResponse({ type: 'query-result', id: request.id, result });
    return;
  }

  if (request.method === 'getClassProperties') {
    const [classId, includeInherited] = request.args as [string, boolean];
    const result = getClassProperties(state.store, classId, includeInherited);
    postResponse({ type: 'query-result', id: request.id, result });
    return;
  }

  if (request.method === 'getNodeClassPropertyEdges') {
    const [classUuids] = request.args as [string[]];
    const result = getNodeClassPropertyEdges(state.store, classUuids);
    postResponse({ type: 'query-result', id: request.id, result });
    return;
  }

  if (request.method === 'getTrashedNodes') {
    const [projectionDepth] = request.args as [number | undefined];
    postResponse({
      type: 'query-result',
      id: request.id,
      result: getTrashedNodes(state.store, projectionDepth),
    });
    return;
  }

  if (request.method === 'getArchivedPages') {
    postResponse({ type: 'query-result', id: request.id, result: getArchivedPages(state.store) });
    return;
  }

  if (request.method === 'getPageAliases') {
    const [canonicalNodeId] = request.args as [string];
    postResponse({
      type: 'query-result',
      id: request.id,
      result: getPageAliases(state.store, canonicalNodeId),
    });
    return;
  }

  if (request.method === 'getCommentNodes') {
    const [nodeUuid] = request.args as [string];
    postResponse({
      type: 'query-result',
      id: request.id,
      result: getCommentNodes(state.store, nodeUuid),
    });
    return;
  }

  const method = (state.store as unknown as Record<string, unknown>)[request.method];
  if (typeof method !== 'function') {
    postResponse({
      type: 'error',
      id: request.id,
      message: `Unknown query method: ${request.method}`,
    });
    return;
  }
  const result = await (method as (...args: unknown[]) => unknown).apply(state.store, request.args);
  postResponse({ type: 'query-result', id: request.id, result });
}

function handleClose(): void {
  state.store = null;
  state.undoManager = null;
  state.workspaceId = null;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    switch (request.type) {
      case 'init':
        await handleInit(request);
        break;
      case 'export':
        handleExport(request);
        break;
      case 'mutate':
        await handleMutate(request);
        break;
      case 'query':
        await handleQuery(request);
        break;
      case 'close':
        handleClose();
        break;
      default:
        // Exhaustiveness guard; unknown messages are ignored.
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if ('id' in request) {
      postResponse({ type: 'error', id: request.id, message });
    } else {
      console.error('[workspaceWorker] Unhandled error:', err);
    }
  }
};

// ─── Sync helper implementations ────────────────────────────────────────────

function loadWatermarks(store: WorkspaceStore): {
  received: Hlc;
  pushed: Hlc;
  restoreEpoch: number;
} {
  const db = store.getDb();
  const workspaceId = store.getWorkspaceId();

  const received = queryOne<{ hlc_physical: number; hlc_logical: number }>(
    db,
    'SELECT hlc_physical, hlc_logical FROM sync_watermark WHERE workspace_id = ?',
    [workspaceId]
  );
  const pushed = queryOne<{ hlc_physical: number; hlc_logical: number }>(
    db,
    'SELECT hlc_physical, hlc_logical FROM sync_push_watermark WHERE workspace_id = ?',
    [workspaceId]
  );
  const epochRow = queryOne<{ restore_epoch: number }>(
    db,
    'SELECT restore_epoch FROM sync_watermark WHERE workspace_id = ?',
    [workspaceId]
  );

  return {
    received: received
      ? { physical: received.hlc_physical, logical: received.hlc_logical }
      : { physical: 0, logical: 0 },
    pushed: pushed
      ? { physical: pushed.hlc_physical, logical: pushed.hlc_logical }
      : { physical: 0, logical: 0 },
    restoreEpoch: epochRow?.restore_epoch ?? 0,
  };
}

function saveWatermark(store: WorkspaceStore, kind: 'received' | 'pushed', hlc: Hlc): void {
  const db = store.getDb();
  const workspaceId = store.getWorkspaceId();
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

function saveRestoreEpoch(store: WorkspaceStore, epoch: number, receivedHlc: Hlc): void {
  const db = store.getDb();
  const workspaceId = store.getWorkspaceId();
  db.run(
    `INSERT INTO sync_watermark (workspace_id, hlc_physical, hlc_logical, restore_epoch)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET
       restore_epoch = excluded.restore_epoch`,
    [workspaceId, receivedHlc.physical, receivedHlc.logical, epoch]
  );
}

function queryOperationLog(store: WorkspaceStore, afterHlc: Hlc, limit: number): OperationRow[] {
  const db = store.getDb();
  const workspaceId = store.getWorkspaceId();
  return queryAll<OperationRow>(
    db,
    `SELECT id, workspace_id, actor_id, hlc_physical, hlc_logical, affected_node_ids, op_type, payload
     FROM operation
     WHERE workspace_id = ?
       AND (hlc_physical > ? OR (hlc_physical = ? AND hlc_logical > ?))
     ORDER BY hlc_physical ASC, hlc_logical ASC
     LIMIT ?`,
    [
      workspaceId,
      afterHlc.physical,
      afterHlc.physical,
      afterHlc.logical,
      limit,
    ]
  );
}
