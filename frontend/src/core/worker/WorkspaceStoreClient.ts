/**
 * Main-thread client for the workspace Web Worker.
 *
 * In real browsers this spawns a dedicated worker that owns sql.js. In test
 * environments (jsdom) it falls back to a same-thread implementation so tests
 * keep working without mocking Web Workers.
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
import {
  type IWorkspaceStoreClient,
  type WorkerRequest,
  type WorkerMessage,
  generateRequestId,
} from './workerProtocol';

export interface WorkspaceStoreClientOptions {
  /** Optional persisted database bytes to hydrate on init. */
  dbBytes?: Uint8Array;
  /** Optional existing store to use directly (test shim to share state). */
  store?: WorkspaceStore;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

function isWorkerSupported(): boolean {
  if (typeof Worker === 'undefined') return false;
  if (typeof navigator === 'undefined') return false;
  // jsdom does not implement Web Workers reliably.
  return !navigator.userAgent.includes('jsdom');
}

class WorkerStoreClient implements IWorkspaceStoreClient {
  private worker: Worker;
  private pending = new Map<number, PendingRequest>();
  private listeners = new Map<string | null, Set<() => void>>();

  constructor(workerUrl: URL) {
    this.worker = new Worker(workerUrl, { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      this.handleMessage(event.data);
    };
    this.worker.onerror = (err) => {
      // Reject all pending requests on a catastrophic worker error.
      for (const { reject } of this.pending.values()) {
        reject(new Error(`Worker error: ${err.message}`));
      }
      this.pending.clear();
    };
  }

  private handleMessage(msg: WorkerMessage): void {
    if (msg.type === 'notify') {
      this.emit(msg.nodeId ?? null);
      return;
    }

    const pending = this.pending.get(msg.id);
    if (!pending) return;
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

  private send<T>(request: WorkerRequest): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!('id' in request)) {
        reject(new Error('Request must have an id'));
        return;
      }
      this.pending.set(request.id, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage(request);
    });
  }

  async init(workspaceId: string, actorId: string, options: WorkspaceStoreClientOptions = {}): Promise<void> {
    await this.send<void>({
      type: 'init',
      id: generateRequestId(),
      workspaceId,
      actorId,
      dbBytes: options.dbBytes,
    });
  }

  async export(): Promise<Uint8Array> {
    return this.send<Uint8Array>({
      type: 'export',
      id: generateRequestId(),
    });
  }

  mutate<T>(method: string, args: unknown[]): Promise<T> {
    return this.send<T>({
      type: 'mutate',
      id: generateRequestId(),
      method,
      args,
    });
  }

  query<T>(method: string, args: unknown[]): Promise<T> {
    return this.send<T>({
      type: 'query',
      id: generateRequestId(),
      method,
      args,
    });
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
    this.worker.postMessage({ type: 'close' });
    this.worker.terminate();
    for (const { reject } of this.pending.values()) {
      reject(new Error('Worker closed'));
    }
    this.pending.clear();
    this.listeners.clear();
  }
}

/**
 * Same-thread fallback used in jsdom/Vitest. It keeps the real WorkspaceStore
 * behaviour without requiring Web Worker support.
 */
class InlineStoreClient implements IWorkspaceStoreClient {
  private store: WorkspaceStore | null = null;

  async init(workspaceId: string, actorId: string, options: WorkspaceStoreClientOptions = {}): Promise<void> {
    if (options.store) {
      this.store = options.store;
      return;
    }
    const db = await createDatabase(options.dbBytes);
    this.store = new WorkspaceStore(db, workspaceId, actorId, {
      onPersist: async () => {
        // Persistence is handled differently in tests.
      },
    });
  }

  async export(): Promise<Uint8Array> {
    if (!this.store) throw new Error('Store not initialized');
    return this.store.export();
  }

  mutate<T>(method: string, args: unknown[]): Promise<T> {
    if (!this.store) return Promise.reject(new Error('Store not initialized'));
    const fn = (this.store as unknown as Record<string, unknown>)[method];
    if (typeof fn !== 'function') {
      return Promise.reject(new Error(`Unknown mutation method: ${method}`));
    }
    return Promise.resolve(fn.apply(this.store, args) as T);
  }

  query<T>(method: string, args: unknown[]): Promise<T> {
    if (!this.store) return Promise.reject(new Error('Store not initialized'));
    // Special-case query helpers that are not methods on WorkspaceStore.
    if (method === 'queryNodes') {
      return Promise.resolve(queryNodes(this.store, args[0] as Parameters<typeof queryNodes>[1]) as T);
    }
    if (method === 'executeQuery') {
      return Promise.resolve(executeQuery(this.store, args[0] as Parameters<typeof executeQuery>[1]) as T);
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

  close(): void {
    this.store = null;
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
    return new WorkerStoreClient(new URL('./workspaceWorker.ts', import.meta.url));
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
