/**
 * IndexedDB persistence for the derived account master key (owner decision
 * 2026-11-04, replacing the plan-02 memory-only ruling for UX): a reload
 * within a signed-in session must NOT require re-unlocking.
 *
 * - Database `notees-custody`, one object store, ONE record:
 *   `{ id: "masterKey", key: CryptoKey }`.
 * - The stored handle is the UNWRAPPED master key, which `@notees/protocol`'s
 *   `unwrapMasterKey` produces `extractable: false` BY CONSTRUCTION — so the
 *   record can never yield raw bytes, and no re-import dance is needed. No
 *   raw key material is ever written anywhere.
 * - Workspace raw keys stay memory-only (unchanged); this store holds the
 *   master handle only.
 * - Cleared at every session end via `clearCryptoCustody` (sign-out,
 *   forget-server, API-key sign-in, rejected credential) — session end
 *   reverts to the password.
 * - Failure modes (no IndexedDB, no record, corrupt read) are SILENT: the
 *   memory-only fallback and the locked banner cover them.
 *
 * The storage is behind a narrow interface so tests inject an in-memory fake
 * (`fake-indexeddb` is not a devDep).
 */

export interface MasterKeyStore {
  store(key: CryptoKey): Promise<void>;
  load(): Promise<CryptoKey | null>;
  delete(): Promise<void>;
}

const DB_NAME = "notees-custody";
const STORE_NAME = "keys";
const RECORD_ID = "masterKey";

class IdbMasterKeyStore implements MasterKeyStore {
  private dbPromise: Promise<IDBDatabase | null> | null = null;

  private open(): Promise<IDBDatabase | null> {
    this.dbPromise ??= new Promise<IDBDatabase | null>((resolve) => {
      try {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) {
            request.result.createObjectStore(STORE_NAME);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.dbPromise;
  }

  async store(key: CryptoKey): Promise<void> {
    const db = await this.open();
    if (db === null) throw new Error("IndexedDB unavailable");
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put({ id: RECORD_ID, key });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("custody store failed"));
      tx.onabort = () => reject(tx.error ?? new Error("custody store aborted"));
    });
  }

  async load(): Promise<CryptoKey | null> {
    const db = await this.open();
    if (db === null) return null;
    return new Promise<CryptoKey | null>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const request = tx.objectStore(STORE_NAME).get(RECORD_ID);
        request.onsuccess = () => {
          const record = request.result as { key?: unknown } | undefined;
          resolve(record !== undefined && record !== null && record.key instanceof CryptoKey ? record.key : null);
        };
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async delete(): Promise<void> {
    const db = await this.open();
    if (db === null) return;
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(RECORD_ID);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }
}

let injected: MasterKeyStore | null | undefined;

function resolveStore(): MasterKeyStore | null {
  if (injected !== undefined) return injected;
  return typeof indexedDB !== "undefined" ? new IdbMasterKeyStore() : null;
}

/** Test seam: inject a fake store (null = force the no-IDB fallback, undefined = reset). */
export function setMasterKeyStoreForTests(store: MasterKeyStore | null | undefined): void {
  injected = store;
}

/** Persist the (non-extractable) master key handle. Rejects on failure. */
export async function storeMasterKey(key: CryptoKey): Promise<void> {
  const store = resolveStore();
  if (store === null) throw new Error("IndexedDB unavailable");
  await store.store(key);
}

/** Load the persisted handle, or null (absent / unavailable / corrupt). Never rejects. */
export async function loadMasterKey(): Promise<CryptoKey | null> {
  try {
    const store = resolveStore();
    if (store === null) return null;
    return await store.load();
  } catch {
    return null;
  }
}

/** Delete the persisted handle. Never rejects. */
export async function deleteMasterKey(): Promise<void> {
  try {
    const store = resolveStore();
    if (store !== null) await store.delete();
  } catch {
    // Deletion is best-effort by design.
  }
}
