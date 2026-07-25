/**
 * Main-thread client for the workspace Web Worker.
 *
 * In real browsers this spawns a dedicated worker that owns sql.js. In test
 * environments (jsdom) it falls back to a same-thread implementation so tests
 * keep working without mocking Web Workers.
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
import {
  type IWorkspaceStoreClient,
  type WorkerRequest,
  type WorkerMessage,
  generateRequestId,
} from './workerProtocol';
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

export interface WorkspaceStoreClientOptions {
  /** Optional persisted database bytes to hydrate on init. */
  dbBytes?: Uint8Array;
  /** Optional existing store to use directly (test shim to share state). */
  store?: WorkspaceStore;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const INIT_TIMEOUT_MS = 60_000;
const EXPORT_TIMEOUT_MS = 60_000;
/** Long timeout for bulk apply operations. Large operation logs can take several
 * minutes to replay on first sync; terminating the worker mid-apply would force
 * a full restart. */
const APPLY_TIMEOUT_MS = 10 * 60_000;

function getTimeoutForMethod(method: string): number {
  switch (method) {
    case 'applyMany':
      return APPLY_TIMEOUT_MS;
    case 'restoreSnapshot':
    case 'exportSnapshot':
      return EXPORT_TIMEOUT_MS;
    default:
      return DEFAULT_REQUEST_TIMEOUT_MS;
  }
}

function isWorkerSupported(): boolean {
  if (typeof Worker === 'undefined') return false;
  if (typeof navigator === 'undefined') return false;
  // jsdom does not implement Web Workers reliably.
  return !navigator.userAgent.includes('jsdom');
}

export class WorkerStoreClient implements IWorkspaceStoreClient {
  private worker: Worker;
  private pending = new Map<number, PendingRequest>();
  private listeners = new Map<string | null, Set<() => void>>();
  private closed = false;

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      this.handleMessage(event.data);
    };
    this.worker.onmessageerror = () => {
      // Reject all pending requests when the worker fails to deserialize a
      // message; the worker is no longer trustworthy.
      this.rejectAllPending(new Error('Worker message deserialization error'));
      this.terminate();
    };
    this.worker.onerror = (err) => {
      // Reject all pending requests on a catastrophic worker error.
      this.rejectAllPending(new Error(`Worker error: ${err.message}`));
      this.terminate();
    };
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private terminate(): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    this.listeners.clear();
  }

  private handleMessage(msg: WorkerMessage): void {
    if (msg.type === 'notify') {
      this.emit(msg.nodeId ?? null);
      return;
    }

    const pending = this.pending.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(msg.id);

    if (msg.type === 'error') {
      pending.reject(new Error(msg.message));
      return;
    }

    if (msg.type === 'init-done') {
      pending.resolve(undefined);
      return;
    }

    if (msg.type === 'export-result') {
      pending.resolve(msg.bytes);
      return;
    }

    if (msg.type === 'mutate-done' || msg.type === 'query-result') {
      pending.resolve(msg.result);
      return;
    }
  }

  private send<T>(request: WorkerRequest, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed) {
        reject(new Error('Worker is closed'));
        return;
      }
      if (!('id' in request)) {
        reject(new Error('Request must have an id'));
        return;
      }
      const id = request.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Do not terminate the worker on a single request timeout. A long
        // sync (e.g. replaying a large operation log) can keep the worker
        // busy for minutes; killing it would abort the sync and force a
        // restart loop. If the worker is genuinely dead, onerror/onmessageerror
        // will terminate it and reject all pending requests.
        reject(
          new Error(
            `Worker request ${request.type}:${id} timed out after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.worker.postMessage(request);
    });
  }

  async init(workspaceId: string, actorId: string, options: WorkspaceStoreClientOptions = {}): Promise<void> {
    await this.send<void>(
      {
        type: 'init',
        id: generateRequestId(),
        workspaceId,
        actorId,
        dbBytes: options.dbBytes,
      },
      INIT_TIMEOUT_MS
    );
  }

  async export(): Promise<Uint8Array> {
    return this.send<Uint8Array>(
      {
        type: 'export',
        id: generateRequestId(),
      },
      EXPORT_TIMEOUT_MS
    );
  }

  mutate<T>(method: string, args: unknown[]): Promise<T> {
    return this.send<T>(
      {
        type: 'mutate',
        id: generateRequestId(),
        method,
        args,
      },
      getTimeoutForMethod(method)
    );
  }

  query<T>(method: string, args: unknown[]): Promise<T> {
    return this.send<T>(
      {
        type: 'query',
        id: generateRequestId(),
        method,
        args,
      },
      getTimeoutForMethod(method)
    );
  }

  subscribe(nodeId: string | null, callback: () => void): () => void {
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

  private emit(nodeId: string | null): void {
    const specific = this.listeners.get(nodeId);
    if (specific) {
      for (const callback of specific) {
        try {
          callback();
        } catch (err) {
          console.error('Workspace store listener error:', err);
        }
      }
    }
    const all = this.listeners.get(null);
    if (all) {
      for (const callback of all) {
        try {
          callback();
        } catch (err) {
          console.error('Workspace store listener error:', err);
        }
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.postMessage({ type: 'close' });
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Worker closed'));
    }
    this.pending.clear();
    this.listeners.clear();
  }

  isClosed(): boolean {
    return this.closed;
  }
}

/**
 * Same-thread fallback used in jsdom/Vitest. It keeps the real WorkspaceStore
 * behaviour without requiring Web Worker support.
 */
class InlineStoreClient implements IWorkspaceStoreClient {
  private store: WorkspaceStore | null = null;
  private undoManager: UndoManager | null = null;
  private closed = false;

  async init(workspaceId: string, actorId: string, options: WorkspaceStoreClientOptions = {}): Promise<void> {
    if (options.store) {
      this.store = options.store;
    } else {
      const db = await createDatabase(options.dbBytes);
      this.store = new WorkspaceStore(db, workspaceId, actorId, {
        onPersist: async () => {
          // Persistence is handled differently in tests.
        },
      });
    }
    this.undoManager = new UndoManager(this.store);
  }

  async export(): Promise<Uint8Array> {
    if (!this.store) throw new Error('Store not initialized');
    return this.store.export();
  }

  mutate<T>(method: string, args: unknown[]): Promise<T> {
    if (!this.store || !this.undoManager) return Promise.reject(new Error('Store not initialized'));

    // Sync-engine helpers.
    if (method === 'applyMany') {
      const [ops] = args as [Operation[]];
      const count = this.store.applyMany(ops);
      return Promise.resolve(count as T);
    }
    if (method === 'startBatch') {
      this.store.startBatch();
      return Promise.resolve(undefined as T);
    }
    if (method === 'endBatch') {
      this.store.endBatch();
      return Promise.resolve(undefined as T);
    }
    if (method === 'restoreSnapshot') {
      const [data] = args as [Uint8Array];
      return this.store.restoreSnapshot(data) as Promise<T>;
    }
    if (method === 'clearOperationLog') {
      this.store.clearOperationLog();
      return Promise.resolve(undefined as T);
    }
    if (method === 'resetDerivedState') {
      this.store.resetDerivedState();
      return Promise.resolve(undefined as T);
    }
    if (method === 'saveWatermark') {
      const [kind, hlc] = args as ['received' | 'pushed', Hlc];
      this.saveWatermark(kind, hlc);
      return Promise.resolve(undefined as T);
    }
    if (method === 'saveRestoreEpoch') {
      const [epoch, receivedHlc] = args as [number, Hlc];
      this.saveRestoreEpoch(epoch, receivedHlc);
      return Promise.resolve(undefined as T);
    }

    // Undo-manager operations are addressed through record-* method names.
    if (method === 'recordCreateNode') {
      const [arg] = args as [Parameters<WorkspaceStore['createNode']>[0]];
      this.undoManager.createNode(arg);
      return Promise.resolve(undefined as T);
    }
    if (method === 'recordCreateBlock') {
      const [arg] = args as [(Parameters<WorkspaceStore['createNode']>[0] & { content?: string })];
      this.undoManager.createBlock(arg);
      return Promise.resolve(undefined as T);
    }
    if (method === 'recordSetNodeText') {
      const [nodeId, value] = args as [string, string];
      this.undoManager.recordSetNodeText(nodeId, value);
      return Promise.resolve(undefined as T);
    }
    if (method === 'recordDeleteNode') {
      const [nodeId] = args as [string];
      this.undoManager.deleteNode(nodeId);
      return Promise.resolve(undefined as T);
    }
    if (method === 'recordMoveNode') {
      const [nodeId, newParentId] = args as [string, string | null];
      this.undoManager.moveNode(nodeId, newParentId);
      return Promise.resolve(undefined as T);
    }
    if (method === 'recordMergeBlocks') {
      const [sourceBlockId, targetBlockId] = args as [string, string];
      this.undoManager.mergeBlocks(sourceBlockId, targetBlockId);
      return Promise.resolve(undefined as T);
    }
    if (method === 'recordSetProperty') {
      const [arg] = args as [Parameters<WorkspaceStore['setProperty']>[0]];
      this.undoManager.setProperty(arg);
      return Promise.resolve(undefined as T);
    }
    if (method === 'recordUnsetProperty') {
      const [arg] = args as [Parameters<WorkspaceStore['unsetProperty']>[0]];
      this.undoManager.unsetProperty(arg);
      return Promise.resolve(undefined as T);
    }
    if (method === 'recordAssignClass') {
      const [nodeId, classId] = args as [string, string];
      this.undoManager.assignClass(nodeId, classId);
      return Promise.resolve(undefined as T);
    }
    if (method === 'recordUnassignClass') {
      const [nodeId, classId] = args as [string, string];
      this.undoManager.unassignClass(nodeId, classId);
      return Promise.resolve(undefined as T);
    }
    if (method === 'undo') {
      const entry = this.undoManager.undo();
      const result = entry ? { label: entry.label, timestamp: entry.timestamp } : null;
      return Promise.resolve(result as T);
    }
    if (method === 'redo') {
      const entry = this.undoManager.redo();
      const result = entry ? { label: entry.label, timestamp: entry.timestamp } : null;
      return Promise.resolve(result as T);
    }
    if (method === 'clearUndoHistory') {
      this.undoManager.clear();
      return Promise.resolve(undefined as T);
    }

    const fn = (this.store as unknown as Record<string, unknown>)[method];
    if (typeof fn !== 'function') {
      return Promise.reject(new Error(`Unknown mutation method: ${method}`));
    }
    return Promise.resolve(fn.apply(this.store, args) as T);
  }

  query<T>(method: string, args: unknown[]): Promise<T> {
    if (!this.store) return Promise.reject(new Error('Store not initialized'));

    // Sync-engine query helpers.
    if (method === 'isDerivedStateStale') {
      return Promise.resolve(this.store.isDerivedStateStale() as T);
    }
    if (method === 'loadWatermarks') {
      return Promise.resolve(this.loadWatermarks() as T);
    }
    if (method === 'queryOperationLog') {
      const [afterHlc, limit] = args as [Hlc, number];
      return Promise.resolve(this.queryOperationLog(afterHlc, limit) as T);
    }
    if (method === 'getWorkspaceId') {
      return Promise.resolve(this.store.getWorkspaceId() as T);
    }
    if (method === 'getActorId') {
      return Promise.resolve(this.store.getActorId() as T);
    }
    if (method === 'exportSnapshot') {
      const [upToHlc] = args as [Hlc | undefined];
      const snapshot = this.store.exportSnapshot(upToHlc);
      return Promise.resolve({ hlc: snapshot.hlc, data: snapshot.data } as T);
    }

    // Undo-manager state queries.
    if (method === 'canUndo') {
      const result = {
        canUndo: this.undoManager?.canUndo() ?? false,
        canRedo: this.undoManager?.canRedo() ?? false,
      };
      return Promise.resolve(result as T);
    }
    if (method === 'getUndoStacks') {
      const stacks = this.undoManager?.getStacks() ?? { undo: [], redo: [] };
      const result = {
        undo: stacks.undo.map((entry) => ({ label: entry.label, timestamp: entry.timestamp })),
        redo: stacks.redo.map((entry) => ({ label: entry.label, timestamp: entry.timestamp })),
      };
      return Promise.resolve(result as T);
    }

    // Special-case query helpers that are not methods on WorkspaceStore.
    if (method === 'listNodes') {
      return Promise.resolve(listNodes(this.store, args[0] as Parameters<typeof listNodes>[1]) as T);
    }
    if (method === 'queryNodes') {
      const filters = args[0] as Parameters<typeof queryNodes>[1];
      return Promise.resolve(queryNodes(this.store, filters) as T);
    }
    if (method === 'executeQuery') {
      const [req, currentNodeUuid] = args as [Parameters<typeof executeQuery>[1], string | undefined];
      return Promise.resolve(executeQuery(this.store, req, currentNodeUuid) as T);
    }
    if (method === 'projectNode') {
      const [nodeId, depth] = args as [string, number | undefined];
      return Promise.resolve(projectNode(this.store, nodeId, depth) as T);
    }
    if (method === 'getNodeProperties') {
      const [nodeId] = args as [string];
      return Promise.resolve(getNodeProperties(this.store, nodeId) as T);
    }
    if (method === 'getPropertySchemas') {
      return Promise.resolve(getPropertySchemas(this.store) as T);
    }
    if (method === 'getPropertySchemaByUuid') {
      const [schemaUuid] = args as [string];
      return Promise.resolve(getPropertySchemaByUuid(this.store, schemaUuid) as T);
    }
    if (method === 'getBatchPropertyValues') {
      const [nodeUuids] = args as [string[]];
      return Promise.resolve(getBatchPropertyValues(this.store, nodeUuids) as T);
    }
    if (method === 'getClassProperties') {
      const [classId, includeInherited] = args as [string, boolean];
      return Promise.resolve(getClassProperties(this.store, classId, includeInherited) as T);
    }
    if (method === 'getNodeClassPropertyEdges') {
      const [classUuids] = args as [string[]];
      return Promise.resolve(getNodeClassPropertyEdges(this.store, classUuids) as T);
    }

    if (method === 'getTrashedNodes') {
      const [projectionDepth] = args as [number | undefined];
      return Promise.resolve(getTrashedNodes(this.store, projectionDepth) as T);
    }

    if (method === 'getArchivedPages') {
      return Promise.resolve(getArchivedPages(this.store) as T);
    }

    if (method === 'getPageAliases') {
      const [canonicalNodeId] = args as [string];
      return Promise.resolve(getPageAliases(this.store, canonicalNodeId) as T);
    }

    if (method === 'getCommentNodes') {
      const [nodeUuid] = args as [string];
      return Promise.resolve(getCommentNodes(this.store, nodeUuid) as T);
    }

    if (method === 'getNodeByUuid') {
      const [nodeUuid] = args as [string];
      return Promise.resolve(getNodeByUuid(this.store, nodeUuid) as T);
    }

    if (method === 'getNodeKindMap') {
      return Promise.resolve(Array.from(getNodeKindMap(this.store).entries()) as T);
    }

    if (method === 'buildBreadcrumbs') {
      const [nodeUuid] = args as [string];
      return Promise.resolve(buildBreadcrumbs(this.store, nodeUuid) as T);
    }

    if (method === 'buildBacklinks') {
      const [nodeUuid] = args as [string];
      return Promise.resolve(buildBacklinks(this.store, nodeUuid) as T);
    }

    if (method === 'buildLinkedReferences') {
      const [nodeUuid, params] = args as [string, { limit?: number; offset?: number } | undefined];
      return Promise.resolve(buildLinkedReferences(this.store, nodeUuid, params) as T);
    }

    if (method === 'buildPropertyBacklinks') {
      const [nodeUuid] = args as [string];
      return Promise.resolve(buildPropertyBacklinks(this.store, nodeUuid) as T);
    }

    if (method === 'buildTasks') {
      const [includeComplete] = args as [boolean | undefined];
      return Promise.resolve(buildTasks(this.store, includeComplete) as T);
    }

    if (method === 'buildTextLinks') {
      const [nodeUuid] = args as [string];
      return Promise.resolve(buildTextLinks(this.store, nodeUuid) as T);
    }

    if (method === 'buildSuggestions') {
      const [classFilters] = args as [string | undefined];
      return Promise.resolve(buildSuggestions(this.store, classFilters) as T);
    }

    if (method === 'buildGraphData') {
      return Promise.resolve(buildGraphData(this.store) as T);
    }

    if (method === 'buildGraphNodes') {
      return Promise.resolve(buildGraphNodes(this.store) as T);
    }

    if (method === 'buildGraphLinks') {
      const [nodeUuids, scope] = args as [string[], 'between' | 'touching' | undefined];
      return Promise.resolve(buildGraphLinks(this.store, nodeUuids, scope) as T);
    }

    if (method === 'getNodeViews') {
      const [nodeUuid, options] = args as [
        string,
        { viewType?: string; includeQueryAST?: boolean } | undefined,
      ];
      return Promise.resolve(getNodeViews(this.store, nodeUuid, options) as T);
    }

    if (method === 'getNodeViewsByType') {
      const [nodeUuid] = args as [string];
      return Promise.resolve(getNodeViewsByType(this.store, nodeUuid) as T);
    }

    if (method === 'getNodeView') {
      const [viewUuid] = args as [string];
      return Promise.resolve(getNodeView(this.store, viewUuid) as T);
    }

    if (method === 'getDefaultNodeView') {
      const [nodeUuid, viewType] = args as [string, string];
      return Promise.resolve(getDefaultNodeView(this.store, nodeUuid, viewType) as T);
    }

    if (method === 'readViewAst') {
      const [viewUuid] = args as [string];
      return Promise.resolve(readViewAst(this.store, viewUuid) as T);
    }

    if (method === 'countQueryResults') {
      const [workspaceId, queryRequest] = args as [
        string,
        { query_ast?: QueryAST; runtime_params?: Record<string, unknown> },
      ];
      return Promise.resolve(countQueryResults(this.store, workspaceId, queryRequest) as T);
    }

    if (method === 'getClassExtends') {
      const [classId, classes] = args as [string, Node[]];
      return Promise.resolve(getClassExtends(this.store, classId, classes) as T);
    }

    if (method === 'getClassExtendsAncestors') {
      const [classId] = args as [string];
      return Promise.resolve(getClassExtendsAncestors(this.store, classId) as T);
    }

    if (method === 'getInheritedProperties') {
      const [classId, classes] = args as [string, Node[]];
      return Promise.resolve(getInheritedProperties(this.store, classId, classes) as T);
    }

    if (method === 'getExtendedByClasses') {
      const [classId, classes] = args as [string, Node[]];
      return Promise.resolve(getExtendedByClasses(this.store, classId, classes) as T);
    }

    if (method === 'getPropertySuggestions') {
      const [contextNodeUuid] = args as [string | undefined];
      return Promise.resolve(getPropertySuggestions(this.store, contextNodeUuid) as T);
    }

    if (method === 'getNodesWithProperty') {
      const [propertyUuid] = args as [string];
      return Promise.resolve(getNodesWithProperty(this.store, propertyUuid) as T);
    }

    if (method === 'validateClassExtends') {
      const [classId, extendsIds] = args as [string, string[]];
      return Promise.resolve(validateClassExtends(this.store, classId, extendsIds) as T);
    }

    if (method === 'getNodesWithRawUuidLinks') {
      return Promise.resolve(getNodesWithRawUuidLinks(this.store) as T);
    }

    const fn = (this.store as unknown as Record<string, unknown>)[method];
    if (typeof fn !== 'function') {
      return Promise.reject(new Error(`Unknown query method: ${method}`));
    }
    return Promise.resolve(fn.apply(this.store, args) as T);
  }

  subscribe(nodeId: string | null, callback: () => void): () => void {
    if (!this.store) {
      return () => {
        // No-op if store was not initialized.
      };
    }
    if (nodeId === null) {
      return this.store.subscribeAll(callback);
    }
    return this.store.subscribe(nodeId, callback);
  }

  private loadWatermarks(): { received: Hlc; pushed: Hlc; restoreEpoch: number } {
    const store = this.store!;
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

  private saveWatermark(kind: 'received' | 'pushed', hlc: Hlc): void {
    const store = this.store!;
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

  private saveRestoreEpoch(epoch: number, receivedHlc: Hlc): void {
    const store = this.store!;
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

  private queryOperationLog(afterHlc: Hlc, limit: number): OperationRow[] {
    const store = this.store!;
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

  close(): void {
    this.closed = true;
    this.store = null;
    this.undoManager = null;
  }

  isClosed(): boolean {
    return this.closed;
  }
}

let sharedClient: IWorkspaceStoreClient | null = null;

/**
 * Create a new workspace store client.
 *
 * In real browsers this spawns a Web Worker. In jsdom tests it falls back to an
 * inline implementation.
 */
export function createWorkspaceStoreClient(): IWorkspaceStoreClient {
  if (isWorkerSupported()) {
    // Create the Worker inline so Vite detects and bundles the worker entry
    // at build time. Passing the URL through a parameter prevents Vite from
    // recognizing it as a worker URL.
    const worker = new Worker(new URL('./workspaceWorker.ts', import.meta.url), {
      type: 'module',
    });
    return new WorkerStoreClient(worker);
  }
  return new InlineStoreClient();
}

/**
 * Return the shared client instance, creating it if necessary.
 */
export function getSharedWorkspaceStoreClient(): IWorkspaceStoreClient {
  if (!sharedClient) {
    sharedClient = createWorkspaceStoreClient();
  }
  return sharedClient;
}

/**
 * Reset the shared client. Useful in tests.
 */
export function resetSharedWorkspaceStoreClient(): void {
  sharedClient?.close();
  sharedClient = null;
}
