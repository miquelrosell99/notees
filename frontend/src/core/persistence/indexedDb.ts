const DB_NAME = 'notees-workspaces';
const DB_VERSION = 1;

export class StorageError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'StorageError';
    this.cause = cause;
  }
}

function openPersistenceDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () =>
        reject(
          new StorageError(
            `Failed to open IndexedDB '${DB_NAME}': ${request.error?.message || 'unknown error'}`,
            request.error
          )
        );
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
    } catch (err) {
      reject(new StorageError('IndexedDB is not available in this environment', err));
    }
  });
}

interface WorkspaceDatabaseRecord {
  workspaceId: string;
  data: Uint8Array;
  updatedAt: string;
}

export async function validateIndexedDb(): Promise<boolean> {
  try {
    const db = await openPersistenceDb();
    db.close();
    return true;
  } catch {
    return false;
  }
}

export async function saveWorkspaceDatabase(workspaceId: string, data: Uint8Array): Promise<void> {
  try {
    const db = await openPersistenceDb();
    const tx = db.transaction('databases', 'readwrite');
    const store = tx.objectStore('databases');
    const record: WorkspaceDatabaseRecord = {
      workspaceId,
      data,
      updatedAt: new Date().toISOString(),
    };
    return new Promise((resolve, reject) => {
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () =>
        reject(
          new StorageError(
            `Failed to save workspace database '${workspaceId}': ${request.error?.message || 'unknown error'}`,
            request.error
          )
        );
    });
  } catch (err) {
    if (err instanceof StorageError) throw err;
    throw new StorageError(
      `Failed to save workspace database '${workspaceId}': ${err instanceof Error ? err.message : String(err)}`,
      err
    );
  }
}

export async function loadWorkspaceDatabase(workspaceId: string): Promise<Uint8Array | undefined> {
  try {
    const db = await openPersistenceDb();
    const tx = db.transaction('databases', 'readonly');
    const store = tx.objectStore('databases');
    return new Promise((resolve, reject) => {
      const request = store.get(workspaceId);
      request.onsuccess = () => {
        const record = request.result as WorkspaceDatabaseRecord | undefined;
        resolve(record?.data);
      };
      request.onerror = () =>
        reject(
          new StorageError(
            `Failed to load workspace database '${workspaceId}': ${request.error?.message || 'unknown error'}`,
            request.error
          )
        );
    });
  } catch (err) {
    if (err instanceof StorageError) throw err;
    throw new StorageError(
      `Failed to load workspace database '${workspaceId}': ${err instanceof Error ? err.message : String(err)}`,
      err
    );
  }
}

export async function deleteWorkspaceDatabase(workspaceId: string): Promise<void> {
  try {
    const db = await openPersistenceDb();
    const tx = db.transaction('databases', 'readwrite');
    const store = tx.objectStore('databases');
    return new Promise((resolve, reject) => {
      const request = store.delete(workspaceId);
      request.onsuccess = () => resolve();
      request.onerror = () =>
        reject(
          new StorageError(
            `Failed to delete workspace database '${workspaceId}': ${request.error?.message || 'unknown error'}`,
            request.error
          )
        );
    });
  } catch (err) {
    if (err instanceof StorageError) throw err;
    throw new StorageError(
      `Failed to delete workspace database '${workspaceId}': ${err instanceof Error ? err.message : String(err)}`,
      err
    );
  }
}
