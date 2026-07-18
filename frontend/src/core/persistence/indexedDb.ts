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

interface WorkspaceDatabaseRecord {
  workspaceId: string;
  data: Uint8Array;
  updatedAt: string;
}

export async function saveWorkspaceDatabase(workspaceId: string, data: Uint8Array): Promise<void> {
  const db = await openPersistenceDb();
  const tx = db.transaction('databases', 'readwrite');
  const store = tx.objectStore('databases');
  const record: WorkspaceDatabaseRecord = { workspaceId, data, updatedAt: new Date().toISOString() };
  return new Promise((resolve, reject) => {
    const request = store.put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Failed to save workspace database'));
  });
}

export async function loadWorkspaceDatabase(workspaceId: string): Promise<Uint8Array | undefined> {
  const db = await openPersistenceDb();
  const tx = db.transaction('databases', 'readonly');
  const store = tx.objectStore('databases');
  return new Promise((resolve, reject) => {
    const request = store.get(workspaceId);
    request.onsuccess = () => {
      const record = request.result as WorkspaceDatabaseRecord | undefined;
      resolve(record?.data);
    };
    request.onerror = () => reject(request.error ?? new Error('Failed to load workspace database'));
  });
}

export async function deleteWorkspaceDatabase(workspaceId: string): Promise<void> {
  const db = await openPersistenceDb();
  const tx = db.transaction('databases', 'readwrite');
  const store = tx.objectStore('databases');
  return new Promise((resolve, reject) => {
    const request = store.delete(workspaceId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Failed to delete workspace database'));
  });
}
