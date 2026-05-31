/**
 * Node Query Worker Client
 *
 * Singleton that manages the nodeQueryWorker instance and exposes a simple
 * Promise-based HTTP interface for use inside TanStack Query `queryFn`s.
 *
 * Usage:
 *   import { nodeQueryWorkerClient } from '@/lib/nodeQueryWorkerClient';
 *
 *   const data = await nodeQueryWorkerClient.get<MyType>('/api/nodes/42/linked-references');
 *   const result = await nodeQueryWorkerClient.post<MyType>('/api/nodes/views/7/execute', body);
 */
import type { WorkerRequest, WorkerResponse } from '@/workers/nodeQueryWorker';
import { getAuthToken, clearAuthToken } from '@/utils/auth';

type PendingEntry = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

let worker: Worker | null = null;
const pending = new Map<string, PendingEntry>();
let seq = 0;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(
      new URL('../workers/nodeQueryWorker.ts', import.meta.url),
      { type: 'module' },
    );

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const { id, data, error } = e.data;
      const entry = pending.get(id);
      if (!entry) return; // already resolved or timed out
      pending.delete(id);

      if (error) {
        if (error.status === 401) {
          // Mirror the axios interceptor: clear auth on 401
          clearAuthToken();
        }
        const err = Object.assign(new Error(error.message), { status: error.status });
        entry.reject(err);
      } else {
        entry.resolve(data);
      }
    };

    worker.onerror = (e) => {
      // Reject all in-flight requests and reset so the next call recreates the worker
      const message = e.message ?? 'Worker crashed';
      for (const entry of pending.values()) {
        entry.reject(new Error(message));
      }
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

function nextId(): string {
  return String(++seq);
}

function request<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const id = nextId();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: (v) => resolve(v as T),
      reject,
    });
    const msg: WorkerRequest = {
      id,
      method,
      url,
      body,
      token: getAuthToken(),
    };
    getWorker().postMessage(msg);
  });
}

export const nodeQueryWorkerClient = {
  get<T>(url: string): Promise<T> {
    return request<T>('GET', url);
  },
  post<T>(url: string, body: unknown): Promise<T> {
    return request<T>('POST', url, body);
  },
};
