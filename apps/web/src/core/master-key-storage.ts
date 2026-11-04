/**
 * IndexedDB persistence for the derived account master key (owner decision
 * 2026-11-04, replacing the plan-02 memory-only ruling for UX): a reload
 * within a signed-in session must NOT require re-unlocking.
 *
 * - Database `notees-custody`, one object store, ONE record:
 *   `{ id: "masterKey", key?: CryptoKey, keyBytes?: Uint8Array }`.
 * - Preferred shape: the UNWRAPPED master key, which `@notees/protocol`'s
 *   `unwrapMasterKey` produces `extractable: false` BY CONSTRUCTION — the
 *   record can never yield raw bytes, and no re-import dance is needed.
 * - Fallback shape (`keyBytes`): Firefox REFUSES to structured-clone a
 *   CryptoKey into IndexedDB (DataCloneError on put — live finding,
 *   2026-11-04), so after a failed CryptoKey put the custody module stores
 *   the raw 32-byte key instead and restore re-imports it non-extractably.
 *   Threat model: the raw bytes are same-origin readable — exactly like the
 *   session token the app already keeps in localStorage; Chromium keeps the
 *   stronger non-extractable handle.
 * - Workspace raw keys stay memory-only (unchanged); this store holds the
 *   master handle only.
 * - Cleared at every session end via `clearCryptoCustody` (sign-out,
 *   forget-server, API-key sign-in, rejected credential) — session end
 *   reverts to the password. `delete` drops the whole record, either shape.
 * - Failure modes (no IndexedDB, no record, corrupt read) are SILENT: the
 *   memory-only fallback and the locked banner cover them.
 *
 * The storage is behind a narrow interface so tests inject an in-memory fake
 * (`fake-indexeddb` is not a devDep). The seam stores and returns the RAW
 * RECORD (shape-agnostic) so the module-level functions own the key↔bytes
 * logic and tests exercise it through the fake.
 */

export interface MasterKeyRecord {
  key?: CryptoKey;
  keyBytes?: Uint8Array;
}

export interface MasterKeyStore {
  /**
   * Put the record (either shape). Rejects when IndexedDB is missing or the
   * put fails — including the Firefox CryptoKey structured-clone refusal,
   * which is the custody module's cue to fall back to `keyBytes`.
   */
  store(record: MasterKeyRecord): Promise<void>;
  /** The raw record (id-stamped), or null when absent/unavailable. Never rejects. */
  load(): Promise<unknown>;
  /** Delete the record. Never rejects. */
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

  async store(record: MasterKeyRecord): Promise<void> {
    const db = await this.open();
    if (db === null) throw new Error("IndexedDB unavailable");
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put({ id: RECORD_ID, ...record });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("custody store failed"));
      tx.onabort = () => reject(tx.error ?? new Error("custody store aborted"));
    });
  }

  async load(): Promise<unknown> {
    const db = await this.open();
    if (db === null) return null;
    return new Promise<unknown>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const request = tx.objectStore(STORE_NAME).get(RECORD_ID);
        request.onsuccess = () => {
          const record = request.result as { id?: unknown } | undefined;
          resolve(record !== undefined && record !== null && record.id === RECORD_ID ? record : null);
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

async function storeRecord(record: MasterKeyRecord): Promise<void> {
  const store = resolveStore();
  if (store === null) throw new Error("IndexedDB unavailable");
  await store.store(record);
}

/** Persist the (non-extractable) handle — the preferred shape. Rejects on failure (incl. the Firefox CryptoKey clone refusal). */
export async function storeMasterKey(key: CryptoKey): Promise<void> {
  await storeRecord({ key });
}

/** Persist the raw-bytes fallback shape (Firefox). Rejects on failure. */
export async function storeMasterKeyBytes(keyBytes: Uint8Array): Promise<void> {
  await storeRecord({ keyBytes });
}

/** Load the persisted handle, or null (absent / unavailable / corrupt). Never rejects. */
export async function loadMasterKey(): Promise<CryptoKey | null> {
  try {
    const store = resolveStore();
    if (store === null) return null;
    const raw = await store.load();
    if (raw === null || typeof raw !== "object") return null;
    const record = raw as MasterKeyRecord;
    if (record.key instanceof CryptoKey) return record.key;
    if (record.keyBytes instanceof Uint8Array) {
      // Firefox fallback record: re-import non-extractable with the master's
      // usages (parity with protocol's unwrapMasterKey).
      return await globalThis.crypto.subtle.importKey(
        "raw",
        record.keyBytes as BufferSource,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
      );
    }
    return null;
  } catch {
    return null;
  }
}

/** Delete the persisted record. Never rejects. */
export async function deleteMasterKey(): Promise<void> {
  try {
    const store = resolveStore();
    if (store !== null) await store.delete();
  } catch {
    // Deletion is best-effort by design.
  }
}
