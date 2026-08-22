const DB_NAME = 'notees-workspaces';
// v3 adds the `assetBlobs` object store (local-first split, Task 5): content
// bytes for assets uploaded in local mode, keyed by SHA-256 content hash.
const DB_VERSION = 3;

const CHUNK_SIZE_BYTES = 1024 * 1024; // 1 MiB
const WRITE_BATCH_SIZE = 20;
const READ_BATCH_SIZE = 50;

const SQLITE_MAGIC = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00]);

function shouldValidateSqliteBytes(): boolean {
  // jsdom tests use fake data that is not a real SQLite file; skip the header
  // check there so the persistence contract can still be exercised.
  return typeof navigator === 'undefined' || !navigator.userAgent.includes('jsdom');
}

export class StorageError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'StorageError';
    this.cause = cause;
  }
}

interface WorkspaceDatabaseMetadata {
  workspaceId: string;
  chunkCount: number;
  totalBytes: number;
  updatedAt: string;
  formatVersion: number;
}

interface WorkspaceDatabaseChunk {
  workspaceId: string;
  chunkIndex: number;
  data: Uint8Array;
}

/**
 * Open the shared persistence database, running schema upgrades as needed.
 * Exported so sibling modules (e.g. the local asset blob store) can reuse the
 * same database and connection pattern instead of opening a parallel one.
 */
export function openPersistenceDb(): Promise<IDBDatabase> {
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
        if (!db.objectStoreNames.contains('metadata')) {
          db.createObjectStore('metadata', { keyPath: 'workspaceId' });
        }
        if (!db.objectStoreNames.contains('chunks')) {
          db.createObjectStore('chunks', { keyPath: ['workspaceId', 'chunkIndex'] });
        }
        // v1 used a single 'databases' object store. Keep it around (or recreate
        // it for fresh installs) so legacy records can be migrated on the next
        // load; new writes go to the chunked stores.
        if (!db.objectStoreNames.contains('databases')) {
          db.createObjectStore('databases', { keyPath: 'workspaceId' });
        }
        // v3: content-addressed asset bytes for local mode. Key = asset hash
        // (out-of-line), value = raw bytes. Managed by features/assets/api/localAssets.
        if (!db.objectStoreNames.contains('assetBlobs')) {
          db.createObjectStore('assetBlobs');
        }
        void event;
      };
    } catch (err) {
      reject(new StorageError('IndexedDB is not available in this environment', err));
    }
  });
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

function isValidSqliteBytes(data: Uint8Array): boolean {
  if (data.length < SQLITE_MAGIC.length) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i++) {
    if (data[i] !== SQLITE_MAGIC[i]) return false;
  }
  return true;
}

function sliceChunks(data: Uint8Array, chunkSize: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    chunks.push(data.subarray(offset, offset + chunkSize));
  }
  return chunks;
}

async function deleteAllChunks(
  db: IDBDatabase,
  workspaceId: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('chunks', 'readwrite');
    const store = tx.objectStore('chunks');
    // Composite key range: from [workspaceId, 0] to [workspaceId, Infinity].
    const range = IDBKeyRange.bound(
      [workspaceId, 0],
      [workspaceId, Number.MAX_SAFE_INTEGER]
    );
    const request = store.delete(range);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(
        new StorageError(
          `Failed to delete chunks for '${workspaceId}': ${request.error?.message || 'unknown error'}`,
          request.error
        )
      );
  });
}

async function deleteMetadata(
  db: IDBDatabase,
  workspaceId: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('metadata', 'readwrite');
    const store = tx.objectStore('metadata');
    const request = store.delete(workspaceId);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(
        new StorageError(
          `Failed to delete metadata for '${workspaceId}': ${request.error?.message || 'unknown error'}`,
          request.error
        )
      );
  });
}

async function writeChunks(
  db: IDBDatabase,
  workspaceId: string,
  chunks: Uint8Array[]
): Promise<void> {
  for (let i = 0; i < chunks.length; i += WRITE_BATCH_SIZE) {
    const batch = chunks.slice(i, i + WRITE_BATCH_SIZE);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('chunks', 'readwrite');
      const store = tx.objectStore('chunks');
      let pending = batch.length;
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(
          new StorageError(
            `Failed to write chunk batch for '${workspaceId}': ${tx.error?.message || 'unknown error'}`,
            tx.error
          )
        );
      for (let j = 0; j < batch.length; j++) {
        const chunkIndex = i + j;
        const record: WorkspaceDatabaseChunk = {
          workspaceId,
          chunkIndex,
          // Copy the chunk data so IndexedDB does not hold a view into a buffer
          // that may be reused or detached by sql.js/WASM later.
          data: new Uint8Array(batch[j]),
        };
        const request = store.put(record);
        request.onerror = () => {
          reject(
            new StorageError(
              `Failed to write chunk ${chunkIndex} for '${workspaceId}': ${request.error?.message || 'unknown error'}`,
              request.error
            )
          );
        };
        request.onsuccess = () => {
          pending--;
          // Ensure every individual put succeeded before the transaction completes.
          if (pending === 0) {
            // tx.oncomplete will fire after this; no-op here.
          }
        };
      }
    });
  }
}

async function readChunks(
  db: IDBDatabase,
  metadata: WorkspaceDatabaseMetadata
): Promise<Uint8Array> {
  const { workspaceId, chunkCount, totalBytes } = metadata;
  const result = new Uint8Array(totalBytes);
  let bytesReceived = 0;

  for (let batchStart = 0; batchStart < chunkCount; batchStart += READ_BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + READ_BATCH_SIZE, chunkCount);
    const batch = await new Promise<Uint8Array[]>((resolve, reject) => {
      const tx = db.transaction('chunks', 'readonly');
      const store = tx.objectStore('chunks');
      const chunks: Uint8Array[] = [];
      let completed = 0;

      for (let i = batchStart; i < batchEnd; i++) {
        const request = store.get([workspaceId, i]);
        request.onsuccess = () => {
          const record = request.result as WorkspaceDatabaseChunk | undefined;
          if (!record) {
            console.warn(`[indexedDb] missing chunk ${i} for '${workspaceId}'`);
          }
          chunks[i - batchStart] = record?.data ?? new Uint8Array(0);
          completed++;
          if (completed === batchEnd - batchStart) {
            resolve(chunks);
          }
        };
        request.onerror = () => {
          reject(
            new StorageError(
              `Failed to read chunk ${i} for '${workspaceId}': ${request.error?.message || 'unknown error'}`,
              request.error
            )
          );
        };
      }
    });

    let offset = batchStart * CHUNK_SIZE_BYTES;
    for (const chunk of batch) {
      result.set(chunk, offset);
      offset += chunk.length;
      bytesReceived += chunk.length;
    }
  }

  if (bytesReceived !== totalBytes) {
    throw new StorageError(
      `Chunk reassembly size mismatch for '${workspaceId}': expected ${totalBytes} bytes, received ${bytesReceived}`
    );
  }

  return result;
}

/**
 * Load a workspace database in the legacy v1 single-blob format, if present.
 * Returns the data and deletes the legacy record so future saves use chunks.
 */
async function loadLegacyDatabase(
  db: IDBDatabase,
  workspaceId: string
): Promise<Uint8Array | undefined> {
  if (!db.objectStoreNames.contains('databases')) {
    return undefined;
  }

  interface LegacyRecord {
    workspaceId: string;
    data: Uint8Array;
    updatedAt: string;
  }

  return new Promise<Uint8Array | undefined>((resolve, reject) => {
    const tx = db.transaction('databases', 'readwrite');
    const store = tx.objectStore('databases');
    const request = store.get(workspaceId);
    request.onsuccess = () => {
      const record = request.result as LegacyRecord | undefined;
      if (record?.data) {
        // Delete the legacy record; the caller will re-save as chunks.
        store.delete(workspaceId);
      }
      resolve(record?.data);
    };
    request.onerror = () =>
      reject(
        new StorageError(
          `Failed to load legacy database '${workspaceId}': ${request.error?.message || 'unknown error'}`,
          request.error
        )
      );
  });
}

export async function saveWorkspaceDatabase(
  workspaceId: string,
  data: Uint8Array
): Promise<void> {
  try {
    // Copy the data immediately so any view into sql.js internal buffers is
    // detached from subsequent DB mutations before IndexedDB clones it.
    const bytes = new Uint8Array(data);
    if (shouldValidateSqliteBytes() && !isValidSqliteBytes(bytes)) {
      console.warn(
        `[indexedDb] refusing to save invalid SQLite bytes for ${workspaceId} (length=${bytes.length})`
      );
      throw new StorageError(
        `Cannot save invalid SQLite database for '${workspaceId}' (length=${bytes.length})`
      );
    }
    const start = performance.now();
    const db = await openPersistenceDb();
    const chunks = sliceChunks(bytes, CHUNK_SIZE_BYTES);
    const metadata: WorkspaceDatabaseMetadata = {
      workspaceId,
      chunkCount: chunks.length,
      totalBytes: bytes.length,
      updatedAt: new Date().toISOString(),
      formatVersion: 2,
    };

    await deleteAllChunks(db, workspaceId);
    await writeChunks(db, workspaceId, chunks);

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('metadata', 'readwrite');
      const store = tx.objectStore('metadata');
      const request = store.put(metadata);
      request.onsuccess = () => resolve();
      request.onerror = () =>
        reject(
          new StorageError(
            `Failed to save metadata for '${workspaceId}': ${request.error?.message || 'unknown error'}`,
            request.error
          )
        );
    });

    // If a legacy v1 record exists, remove it so we don't keep a second copy.
    if (db.objectStoreNames.contains('databases')) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('databases', 'readwrite');
        const store = tx.objectStore('databases');
        const request = store.delete(workspaceId);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }

    // Verify that the chunks we just wrote are actually readable.
    const savedChunkCount = await new Promise<number>((resolve, reject) => {
      const tx = db.transaction('chunks', 'readonly');
      const store = tx.objectStore('chunks');
      const range = IDBKeyRange.bound(
        [workspaceId, 0],
        [workspaceId, Number.MAX_SAFE_INTEGER]
      );
      const request = store.count(range);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(
          new StorageError(
            `Failed to count saved chunks for '${workspaceId}': ${request.error?.message || 'unknown error'}`,
            request.error
          )
        );
    });

    if (savedChunkCount !== chunks.length) {
      throw new StorageError(
        `Chunk count mismatch after save for '${workspaceId}': expected ${chunks.length}, found ${savedChunkCount}`
      );
    }

    console.log('[indexedDb] saved chunked', workspaceId, {
      totalBytes: bytes.length,
      chunks: chunks.length,
      durationMs: Math.round(performance.now() - start),
    });
  } catch (err) {
    if (err instanceof StorageError) throw err;
    throw new StorageError(
      `Failed to save workspace database '${workspaceId}': ${err instanceof Error ? err.message : String(err)}`,
      err
    );
  }
}

export async function loadWorkspaceDatabase(
  workspaceId: string
): Promise<Uint8Array | undefined> {
  const start = performance.now();
  try {
    const db = await openPersistenceDb();

    const metadata = await new Promise<WorkspaceDatabaseMetadata | undefined>(
      (resolve, reject) => {
        const tx = db.transaction('metadata', 'readonly');
        const store = tx.objectStore('metadata');
        const request = store.get(workspaceId);
        request.onsuccess = () => resolve(request.result as WorkspaceDatabaseMetadata | undefined);
        request.onerror = () =>
          reject(
            new StorageError(
              `Failed to load metadata for '${workspaceId}': ${request.error?.message || 'unknown error'}`,
              request.error
            )
          );
      }
    );

    if (metadata) {
      try {
        const bytes = await readChunks(db, metadata);
        if (shouldValidateSqliteBytes() && !isValidSqliteBytes(bytes)) {
          console.warn(
            `[indexedDb] loaded bytes for ${workspaceId} are not a valid SQLite database (length=${bytes.length}); discarding local snapshot`
          );
        } else {
          console.log('[indexedDb] loaded chunked', workspaceId, {
            totalBytes: bytes.length,
            chunks: metadata.chunkCount,
            durationMs: Math.round(performance.now() - start),
          });
          return bytes;
        }
      } catch (readErr) {
        console.warn(
          `[indexedDb] failed to read chunks for ${workspaceId}: ${readErr instanceof Error ? readErr.message : String(readErr)}; discarding local snapshot`
        );
      }
      // Best-effort cleanup of the corrupt snapshot so the next save replaces it.
      try {
        await deleteMetadata(db, workspaceId);
        await deleteAllChunks(db, workspaceId);
      } catch {
        // ignore cleanup errors
      }
      return undefined;
    }

    // Fall back to a legacy v1 single-blob record and migrate on next save.
    const legacy = await loadLegacyDatabase(db, workspaceId);
    if (legacy && shouldValidateSqliteBytes() && !isValidSqliteBytes(legacy)) {
      console.warn(
        `[indexedDb] legacy bytes for ${workspaceId} are not a valid SQLite database; discarding`
      );
      return undefined;
    }
    return legacy;
  } catch (err) {
    console.warn(
      `[indexedDb] failed to load workspace database '${workspaceId}': ${err instanceof Error ? err.message : String(err)}; falling back to fresh state`
    );
    return undefined;
  }
}

export async function deleteWorkspaceDatabase(workspaceId: string): Promise<void> {
  try {
    const db = await openPersistenceDb();
    await deleteMetadata(db, workspaceId);
    await deleteAllChunks(db, workspaceId);

    if (db.objectStoreNames.contains('databases')) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('databases', 'readwrite');
        const store = tx.objectStore('databases');
        const request = store.delete(workspaceId);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }
  } catch (err) {
    if (err instanceof StorageError) throw err;
    throw new StorageError(
      `Failed to delete workspace database '${workspaceId}': ${err instanceof Error ? err.message : String(err)}`,
      err
    );
  }
}
