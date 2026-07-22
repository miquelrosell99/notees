/**
 * Workspace Web Worker
 *
 * Owns the sql.js Database and the real WorkspaceStore. All heavy work
 * (mutations, queries, sync apply, export) happens here, off the main thread.
 */

import { createDatabase } from '../db/connection';
import { WorkspaceStore } from '../store';
import { queryAll, queryOne } from '../db/sqlite';
import { listNodes } from '../query/listNodes';
import { queryNodes } from '../query/queryNodes';
import { executeQuery } from '../query/executeQuery';
import { buildGraphData } from '../query/graphData';
import { buildGraphNodes } from '../query/graphNodes';
import { buildGraphLinks } from '../query/graphLinks';
import { projectNode } from '../adapters/nodeProjection';
import {
  getNodeProperties,
  getPropertySchemas,
  getPropertySchemaByUuid,
  getBatchPropertyValues,
  getClassProperties,
  getNodeClassPropertyEdges,
} from '../adapters/propertyQueries';
import { UndoManager } from '../undo/UndoManager';
import type { Hlc } from '../clock';
import type { Operation } from '../types/operation';
import type { OperationRow } from '../sync';
import type { Node } from '@/types/api';
import type { QueryAST } from '@/types/queryAST';
import type { WorkerRequest, WorkerResponse, NotifyChangeMessage } from './workerProtocol';
import {
  buildBacklinks,
  buildBreadcrumbs,
  buildLinkedReferences,
  buildPropertyBacklinks,
  buildSuggestions,
  buildTasks,
  buildTextLinks,
  countQueryResults,
  getArchivedPages,
  getCommentNodes,
  getDefaultNodeView,
  getExtendedByClasses,
  getInheritedProperties,
  getClassExtends,
  getClassExtendsAncestors,
  getNodeByUuid,
  getNodeKindMap,
  getNodeView,
  getNodeViews,
  getNodeViewsByType,
  getNodesWithProperty,
  getNodesWithRawUuidLinks,
  getPageAliases,
  getPropertySuggestions,
  getTrashedNodes,
  readViewAst,
  validateClassExtends,
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

const INIT_SQL_TIMEOUT_MS = 60_000;

async function handleInit(request: Extract<WorkerRequest, { type: 'init' }>): Promise<void> {
  if (state.store) {
    // Close existing store gracefully if re-initializing.
    state.store = null;
    state.undoManager = null;
    state.workspaceId = null;
  }

  const db = await Promise.race([
    createDatabase(request.dbBytes),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error('sql.js initialization timed out in worker')),
        INIT_SQL_TIMEOUT_MS
      );
    }),
  ]);
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
  if (request.method === 'listNodes') {
    const result = listNodes(state.store, request.args[0] as Parameters<typeof listNodes>[1]);
    postResponse({ type: 'query-result', id: request.id, result });
    return;
  }

  if (request.method === 'queryNodes') {
    const result = queryNodes(state.store, request.args[0] as Parameters<typeof queryNodes>[1]);
    postResponse({ type: 'query-result', id: request.id, result });
    return;
  }

  if (request.method === 'executeQuery') {
    const [req, currentNodeUuid] = request.args as [
      Parameters<typeof executeQuery>[1],
      string | undefined,
    ];
    const result = executeQuery(state.store, req, currentNodeUuid);
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

  if (request.method === 'getPropertySchemaByUuid') {
    const [schemaUuid] = request.args as [string];
    const result = getPropertySchemaByUuid(state.store, schemaUuid);
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

  if (request.method === 'getNodeByUuid') {
    const [nodeUuid] = request.args as [string];
    postResponse({
      type: 'query-result',
      id: request.id,
      result: getNodeByUuid(state.store, nodeUuid),
    });
    return;
  }

  if (request.method === 'getNodeKindMap') {
    postResponse({
      type: 'query-result',
      id: request.id,
      result: Array.from(getNodeKindMap(state.store).entries()),
    });
    return;
  }

  if (request.method === 'buildBreadcrumbs') {
    const [nodeUuid] = request.args as [string];
    postResponse({
      type: 'query-result',
      id: request.id,
      result: buildBreadcrumbs(state.store, nodeUuid),
    });
    return;
  }

  if (request.method === 'buildBacklinks') {
    const [nodeUuid] = request.args as [string];
    postResponse({
      type: 'query-result',
      id: request.id,
      result: buildBacklinks(state.store, nodeUuid),
    });
    return;
  }

  if (request.method === 'buildLinkedReferences') {
    const [nodeUuid, params] = request.args as [string, { limit?: number; offset?: number } | undefined];
    postResponse({
      type: 'query-result',
      id: request.id,
      result: buildLinkedReferences(state.store, nodeUuid, params),
    });
    return;
  }

  if (request.method === 'buildPropertyBacklinks') {
    const [nodeUuid] = request.args as [string];
    postResponse({
      type: 'query-result',
      id: request.id,
      result: buildPropertyBacklinks(state.store, nodeUuid),
    });
    return;
  }

  if (request.method === 'buildTasks') {
    const [includeComplete] = request.args as [boolean | undefined];
    postResponse({
      type: 'query-result',
      id: request.id,
      result: buildTasks(state.store, includeComplete),
    });
    return;
  }

  if (request.method === 'buildTextLinks') {
    const [nodeUuid] = request.args as [string];
    postResponse({
      type: 'query-result',
      id: request.id,
      result: buildTextLinks(state.store, nodeUuid),
    });
    return;
  }

  if (request.method === 'buildSuggestions') {
    const [classFilters] = request.args as [string | undefined];
    postResponse({
      type: 'query-result',
      id: request.id,
      result: buildSuggestions(state.store, classFilters),
    });
    return;
  }

  if (request.method === 'buildGraphData') {
    postResponse({
      type: 'query-result',
      id: request.id,
      result: buildGraphData(state.store),
    });
    return;
  }

  if (request.method === 'buildGraphNodes') {
    postResponse({
      type: 'query-result',
      id: request.id,
      result: buildGraphNodes(state.store),
    });
    return;
  }

  if (request.method === 'buildGraphLinks') {
    const [nodeUuids, scope] = request.args as [string[], 'between' | 'touching' | undefined];
    postResponse({
      type: 'query-result',
      id: request.id,
      result: buildGraphLinks(state.store, nodeUuids, scope),
    });
    return;
  }

  if (request.method === 'getNodeViews') {
    const [nodeUuid, options] = request.args as [
      string,
      { viewType?: string; includeQueryAST?: boolean } | undefined,
    ];
    postResponse({
      type: 'query-result',
      id: request.id,
      result: getNodeViews(state.store, nodeUuid, options),
    });
    return;
  }

  if (request.method === 'getNodeViewsByType') {
    const [nodeUuid] = request.args as [string];
    postResponse({
      type: 'query-result',
      id: request.id,
      result: getNodeViewsByType(state.store, nodeUuid),
    });
    return;
  }

  if (request.method === 'getNodeView') {
    const [viewUuid] = request.args as [string];
    postResponse({
      type: 'query-result',
      id: request.id,
      result: getNodeView(state.store, viewUuid),
    });
    return;
  }

  if (request.method === 'getDefaultNodeView') {
    const [nodeUuid, viewType] = request.args as [string, string];
    postResponse({
      type: 'query-result',
      id: request.id,
      result: getDefaultNodeView(state.store, nodeUuid, viewType),
    });
    return;
  }

  if (request.method === 'readViewAst') {
    const [viewUuid] = request.args as [string];
    postResponse({
      type: 'query-result',
      id: request.id,
      result: readViewAst(state.store, viewUuid),
    });
    return;
  }

  if (request.method === 'countQueryResults') {
    const [workspaceId, queryRequest] = request.args as [
      string,
      { query_ast?: QueryAST; runtime_params?: Record<string, unknown> },
    ];
    postResponse({
      type: 'query-result',
      id: request.id,
      result: countQueryResults(state.store, workspaceId, queryRequest),
    });
    return;
  }

  if (request.method === 'getClassExtends') {
    const [classId, classes] = request.args as [string, Node[]];
    postResponse({
      type: 'query-result',
      id: request.id,
      result: getClassExtends(state.store, classId, classes),
    });
    return;
  }

  if (request.method === 'getClassExtendsAncestors') {
    const [classId] = request.args as [string];
    postResponse({
      type: 'query-result',
      id: request.id,
      result: getClassExtendsAncestors(state.store, classId),
    });
    return;
  }

  if (request.method === 'getInheritedProperties') {
    const [classId, classes] = request.args as [string, Node[]];
    postResponse({
      type: 'query-result',
      id: request.id,
      result: getInheritedProperties(state.store, classId, classes),
    });
    return;
  }

  if (request.method === 'getExtendedByClasses') {
    const [classId, classes] = request.args as [string, Node[]];
    postResponse({
      type: 'query-result',
      id: request.id,
      result: getExtendedByClasses(state.store, classId, classes),
    });
    return;
  }

  if (request.method === 'getPropertySuggestions') {
    const [contextNodeUuid] = request.args as [string | undefined];
    postResponse({
      type: 'query-result',
      id: request.id,
      result: getPropertySuggestions(state.store, contextNodeUuid),
    });
    return;
  }

  if (request.method === 'getNodesWithProperty') {
    const [propertyUuid] = request.args as [string];
    postResponse({
      type: 'query-result',
      id: request.id,
      result: getNodesWithProperty(state.store, propertyUuid),
    });
    return;
  }

  if (request.method === 'validateClassExtends') {
    const [classId, extendsIds] = request.args as [string, string[]];
    postResponse({
      type: 'query-result',
      id: request.id,
      result: validateClassExtends(state.store, classId, extendsIds),
    });
    return;
  }

  if (request.method === 'getNodesWithRawUuidLinks') {
    postResponse({
      type: 'query-result',
      id: request.id,
      result: getNodesWithRawUuidLinks(state.store),
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
