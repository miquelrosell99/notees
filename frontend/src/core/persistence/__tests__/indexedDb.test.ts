import { describe, it, expect, beforeEach } from 'vitest';
import {
  deleteWorkspaceDatabase,
  loadWorkspaceDatabase,
  saveWorkspaceDatabase,
  validateIndexedDb,
} from '../indexedDb';

describe('indexedDb persistence', () => {
  beforeEach(async () => {
    await deleteWorkspaceDatabase('ws-test');
  });

  it('saves and loads a workspace database', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    await saveWorkspaceDatabase('ws-test', data);
    const loaded = await loadWorkspaceDatabase('ws-test');
    expect(loaded).toBeDefined();
    expect(Array.from(loaded!)).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns undefined when no database exists', async () => {
    const loaded = await loadWorkspaceDatabase('ws-missing');
    expect(loaded).toBeUndefined();
  });

  it('deletes a saved database', async () => {
    const data = new Uint8Array([9, 8, 7]);
    await saveWorkspaceDatabase('ws-test', data);
    await deleteWorkspaceDatabase('ws-test');
    const loaded = await loadWorkspaceDatabase('ws-test');
    expect(loaded).toBeUndefined();
  });

  it('overwrites an existing database', async () => {
    await saveWorkspaceDatabase('ws-test', new Uint8Array([1, 1, 1]));
    await saveWorkspaceDatabase('ws-test', new Uint8Array([2, 2, 2]));
    const loaded = await loadWorkspaceDatabase('ws-test');
    expect(Array.from(loaded!)).toEqual([2, 2, 2]);
  });

  it('validates that IndexedDB can be opened', async () => {
    await expect(validateIndexedDb()).resolves.toBe(true);
  });

  it('round-trips data larger than one chunk', async () => {
    const size = 1024 * 1024 + 123; // slightly more than 1 MiB
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      data[i] = i % 256;
    }
    await saveWorkspaceDatabase('ws-test', data);
    const loaded = await loadWorkspaceDatabase('ws-test');
    expect(loaded).toBeDefined();
    expect(loaded!.length).toBe(size);
    expect(loaded!).toEqual(data);
  });

  it('overwrites chunked data with smaller data', async () => {
    const large = new Uint8Array(1024 * 1024 * 2 + 7);
    large.fill(0xaa);
    await saveWorkspaceDatabase('ws-test', large);

    const small = new Uint8Array([1, 2, 3]);
    await saveWorkspaceDatabase('ws-test', small);

    const loaded = await loadWorkspaceDatabase('ws-test');
    expect(loaded).toBeDefined();
    expect(loaded!).toEqual(small);
  });

  it('reads a legacy v1 single-blob record and migrates it', async () => {
    const legacyData = new Uint8Array([10, 20, 30, 40]);
    const db = await openTestDb();
    try {
      await writeLegacyRecord(db, 'ws-test', legacyData);
      const loaded = await loadWorkspaceDatabase('ws-test');
      expect(loaded).toBeDefined();
      expect(Array.from(loaded!)).toEqual(Array.from(legacyData));

      // Re-saving should write chunked data and remove the legacy record.
      await saveWorkspaceDatabase('ws-test', new Uint8Array([5, 6, 7]));
      const legacyAfterSave = await readLegacyRecord(db, 'ws-test');
      expect(legacyAfterSave).toBeUndefined();
      const chunked = await loadWorkspaceDatabase('ws-test');
      expect(chunked).toEqual(new Uint8Array([5, 6, 7]));
    } finally {
      db.close();
    }
  });
});

// Helpers for legacy v1 migration tests. These bypass the public API because
// v1 is no longer written by production code.
function openTestDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('notees-workspaces', 2);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('databases')) {
        db.createObjectStore('databases', { keyPath: 'workspaceId' });
      }
    };
  });
}

function writeLegacyRecord(
  db: IDBDatabase,
  workspaceId: string,
  data: Uint8Array
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('databases', 'readwrite');
    const store = tx.objectStore('databases');
    const request = store.put({ workspaceId, data, updatedAt: new Date().toISOString() });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function readLegacyRecord(
  db: IDBDatabase,
  workspaceId: string
): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('databases', 'readonly');
    const store = tx.objectStore('databases');
    const request = store.get(workspaceId);
    request.onsuccess = () => {
      const record = request.result as { data?: Uint8Array } | undefined;
      resolve(record?.data);
    };
    request.onerror = () => reject(request.error);
  });
}
