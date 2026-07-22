/**
 * Workspace Web Worker
 *
 * Owns the sql.js Database and the real WorkspaceStore. All heavy work
 * (mutations, queries, sync apply, export) happens here, off the main thread.
 */

import { createDatabase } from '../db/connection';
import { WorkspaceStore } from '../store';
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
import type { WorkerRequest, WorkerResponse, NotifyChangeMessage } from './workerProtocol';

interface WorkerState {
  store: WorkspaceStore | null;
  workspaceId: string | null;
}

const state: WorkerState = {
  store: null,
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

function handleMutate(request: Extract<WorkerRequest, { type: 'mutate' }>): void {
  if (!state.store) {
    postResponse({ type: 'error', id: request.id, message: 'Store not initialized' });
    return;
  }
  const method = (state.store as unknown as Record<string, unknown>)[request.method];
  if (typeof method !== 'function') {
    postResponse({
      type: 'error',
      id: request.id,
      message: `Unknown mutation method: ${request.method}`,
    });
    return;
  }
  const result = (method as (...args: unknown[]) => unknown).apply(state.store, request.args);
  postResponse({ type: 'mutate-done', id: request.id, result });
  postNotify();
}

function handleQuery(request: Extract<WorkerRequest, { type: 'query' }>): void {
  if (!state.store) {
    postResponse({ type: 'error', id: request.id, message: 'Store not initialized' });
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

  const method = (state.store as unknown as Record<string, unknown>)[request.method];
  if (typeof method !== 'function') {
    postResponse({
      type: 'error',
      id: request.id,
      message: `Unknown query method: ${request.method}`,
    });
    return;
  }
  const result = (method as (...args: unknown[]) => unknown).apply(state.store, request.args);
  postResponse({ type: 'query-result', id: request.id, result });
}

function handleClose(): void {
  state.store = null;
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
        handleMutate(request);
        break;
      case 'query':
        handleQuery(request);
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

