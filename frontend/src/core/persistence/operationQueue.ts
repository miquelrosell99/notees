import type { Operation } from '../types/operation';

const DB_NAME = 'notees-workspaces';
const DB_VERSION = 1;

function openPersistenceDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains('databases')) {
        db.createObjectStore('databases', { keyPath: 'workspaceId' });
      }
      if (!db.objectStoreNames.contains('operationQueue')) {
        db.createObjectStore('operationQueue', { keyPath: 'workspaceId' });
      }
      // Silence the unused parameter warning while keeping event in signature.
      void event;
    };
  });
}

interface OperationQueueRecord {
  workspaceId: string;
  operations: Operation[];
  updatedAt: string;
}

export async function queueOperation(workspaceId: string, op: Operation): Promise<void> {
  const db = await openPersistenceDb();
  const tx = db.transaction('operationQueue', 'readwrite');
  const store = tx.objectStore('operationQueue');
  const existing = await new Promise<OperationQueueRecord | undefined>((resolve, reject) => {
    const request = store.get(workspaceId);
    request.onsuccess = () => resolve(request.result as OperationQueueRecord | undefined);
    request.onerror = () => reject(request.error ?? new Error('Failed to read operation queue'));
  });
  const operations = existing ? [...existing.operations, op] : [op];
  const record: OperationQueueRecord = { workspaceId, operations, updatedAt: new Date().toISOString() };
  return new Promise((resolve, reject) => {
    const request = store.put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Failed to queue operation'));
  });
}

export async function drainQueuedOperations(workspaceId: string): Promise<Operation[]> {
  const db = await openPersistenceDb();
  const tx = db.transaction('operationQueue', 'readwrite');
  const store = tx.objectStore('operationQueue');
  const operations = await new Promise<Operation[]>((resolve, reject) => {
    const request = store.get(workspaceId);
    request.onsuccess = () => {
      const record = request.result as OperationQueueRecord | undefined;
      resolve(record?.operations ?? []);
    };
    request.onerror = () => reject(request.error ?? new Error('Failed to drain operation queue'));
  });
  await new Promise<void>((resolve, reject) => {
    const request = store.delete(workspaceId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Failed to clear operation queue'));
  });
  return operations;
}

export async function clearQueuedOperations(workspaceId: string): Promise<void> {
  const db = await openPersistenceDb();
  const tx = db.transaction('operationQueue', 'readwrite');
  const store = tx.objectStore('operationQueue');
  return new Promise((resolve, reject) => {
    const request = store.delete(workspaceId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Failed to clear operation queue'));
  });
}
