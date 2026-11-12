/**
 * IndexedDB persistence for the derived account master key (owner decision
 * 2026-11-04, replacing the plan-02 memory-only ruling for UX): a reload
 * within a signed-in session must NOT require re-unlocking.
 *
 * - Database `notees-custody`, object store `keys`, ONE record:
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
 * - Cleared at every session end via `clearCryptoCustody` (sign-out,
 *   forget-server, API-key sign-in, rejected credential) — session end
 *   reverts to the password. `delete` drops the whole record, either shape.
 * - Failure modes (no IndexedDB, no record, corrupt read) are SILENT: the
 *   memory-only fallback and the locked banner cover them.
 *
 * A SECOND store, `workspaceKeys` (added Task 9, DB version 2), holds the
 * device-local keys of offline workspaces — one record per workspace id,
 * `{ id: <workspaceId>, key?: CryptoKey, keyBytes?: Uint8Array }`, same
 * preferred/fallback shapes. These records are NOT session state: the
 * offline workspace has no account, and each key protects content sealed
 * under it (wire/outbox envelopes), so session end (sign-out) must NOT
 * delete them — a fresh key would orphan that content (data-availability
 * ruling). They must not leak forever either, though: workspace removal
 * deletes the workspace's record (`deleteOfflineWorkspaceKey`, F1), and a
 * workspace re-created after the removal mints a FRESH key. See
 * `getOfflineWorkspaceKey`/`persistOfflineWorkspaceKey` below.
 *
 * The storage is behind a narrow interface so tests inject an in-memory fake
 * (`fake-indexeddb` is not a devDep). The seam stores and returns the RAW
 * RECORD (shape-agnostic) so the module-level functions own the key↔bytes
 * logic and tests exercise it through the fake.
 */

import { exportWorkspaceKey } from "@notees/protocol";

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
const WORKSPACE_STORE_NAME = "workspaceKeys";
/** Version 2 adds the `workspaceKeys` store (Task 9); v1 databases upgrade in place. */
const DB_VERSION = 2;
const RECORD_ID = "masterKey";

function openCustodyDb(): Promise<IDBDatabase | null> {
  return new Promise<IDBDatabase | null>((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
        if (!request.result.objectStoreNames.contains(WORKSPACE_STORE_NAME)) {
          request.result.createObjectStore(WORKSPACE_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

class IdbMasterKeyStore implements MasterKeyStore {
  private dbPromise: Promise<IDBDatabase | null> | null = null;

  private open(): Promise<IDBDatabase | null> {
    this.dbPromise ??= openCustodyDb();
    return this.dbPromise;
  }

  async store(record: MasterKeyRecord): Promise<void> {
    const db = await this.open();
    if (db === null) throw new Error("IndexedDB unavailable");
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      // The explicit key is required: Firefox rejects a keyless put on an
      // out-of-line store ("Data provided to an operation does not meet
      // requirements") where Chromium auto-generates one.
      tx.objectStore(STORE_NAME).put({ id: RECORD_ID, ...record }, RECORD_ID);
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

// --- offline workspace keys (Task 9) ------------------------------------------------
//
// The "Work offline" local-only workspace is keyed at creation; its key is
// device-local custody in the SAME database, store `workspaceKeys`, one
// record per workspace id (`{ id, key?|keyBytes? }` — the identical
// Chromium-handle / Firefox-bytes shapes). Unlike the master record these
// SURVIVE session end: sign-out must not orphan the sealed offline content
// (the T9 data-availability ruling — the key protects wire/outbox envelopes
// sealed under it). F1 adds the cleanup seam the other way: workspace
// removal deletes the one record, so a custody record never outlives its
// workspace; a re-create mints a fresh key.

export interface WorkspaceKeyRecord {
  key?: CryptoKey;
  keyBytes?: Uint8Array;
}

export interface WorkspaceKeyStore {
  /** Put the record under the workspace id. Rejects on failure (incl. the Firefox CryptoKey clone refusal). */
  store(id: string, record: WorkspaceKeyRecord): Promise<void>;
  /** The raw record (id-stamped), or null when absent/unavailable. Never rejects. */
  load(id: string): Promise<unknown>;
  /** Delete the record. Never rejects. */
  delete(id: string): Promise<void>;
}

class IdbWorkspaceKeyStore implements WorkspaceKeyStore {
  private dbPromise: Promise<IDBDatabase | null> | null = null;

  private open(): Promise<IDBDatabase | null> {
    this.dbPromise ??= openCustodyDb();
    return this.dbPromise;
  }

  async store(id: string, record: WorkspaceKeyRecord): Promise<void> {
    const db = await this.open();
    if (db === null) throw new Error("IndexedDB unavailable");
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(WORKSPACE_STORE_NAME, "readwrite");
      // The explicit key is required: Firefox rejects a keyless put on an
      // out-of-line store, same as the master record above.
      tx.objectStore(WORKSPACE_STORE_NAME).put({ id, ...record }, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("custody store failed"));
      tx.onabort = () => reject(tx.error ?? new Error("custody store aborted"));
    });
  }

  async load(id: string): Promise<unknown> {
    const db = await this.open();
    if (db === null) return null;
    return new Promise<unknown>((resolve) => {
      try {
        const tx = db.transaction(WORKSPACE_STORE_NAME, "readonly");
        const request = tx.objectStore(WORKSPACE_STORE_NAME).get(id);
        request.onsuccess = () => {
          const record = request.result as { id?: unknown } | undefined;
          resolve(record !== undefined && record !== null && record.id === id ? record : null);
        };
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async delete(id: string): Promise<void> {
    const db = await this.open();
    if (db === null) return;
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(WORKSPACE_STORE_NAME, "readwrite");
        tx.objectStore(WORKSPACE_STORE_NAME).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }
}

let injectedWorkspaceStore: WorkspaceKeyStore | null | undefined;

function resolveWorkspaceStore(): WorkspaceKeyStore | null {
  if (injectedWorkspaceStore !== undefined) return injectedWorkspaceStore;
  return typeof indexedDB !== "undefined" ? new IdbWorkspaceKeyStore() : null;
}

/** Test seam: inject a fake workspace-key store (null = force the no-IDB fallback, undefined = reset). */
export function setWorkspaceKeyStoreForTests(store: WorkspaceKeyStore | null | undefined): void {
  injectedWorkspaceStore = store;
}

/**
 * Persist a device-local offline workspace key. Tries the CryptoKey handle
 * first; on the Firefox structured-clone refusal falls back to the raw-bytes
 * record (the workspace key is extractable by construction, so the bytes are
 * always obtainable). Rejects only when BOTH shapes fail.
 */
export async function persistOfflineWorkspaceKey(workspaceId: string, key: CryptoKey): Promise<void> {
  const store = resolveWorkspaceStore();
  if (store === null) throw new Error("IndexedDB unavailable");
  try {
    await store.store(workspaceId, { key });
  } catch {
    await store.store(workspaceId, { keyBytes: await exportWorkspaceKey(key) });
  }
}

/**
 * The persisted device-local key for an offline workspace, or null (absent /
 * unavailable / corrupt). The bytes fallback re-imports EXTRACTABLE with the
 * workspace-key usages: the restored handle must both seal content and be
 * exportable/wrappable when the wrap publishes on the first password-session
 * sync. Never rejects.
 */
export async function getOfflineWorkspaceKey(workspaceId: string): Promise<CryptoKey | null> {
  try {
    const store = resolveWorkspaceStore();
    if (store === null) return null;
    const raw = await store.load(workspaceId);
    if (raw === null || typeof raw !== "object") return null;
    const record = raw as WorkspaceKeyRecord;
    if (record.key instanceof CryptoKey) return record.key;
    if (record.keyBytes instanceof Uint8Array) {
      return await globalThis.crypto.subtle.importKey(
        "raw",
        record.keyBytes as BufferSource,
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Delete one workspace's custody record (workspace delete/forget). Missing
 * records are fine — resolves silently. Never rejects.
 */
export async function deleteOfflineWorkspaceKey(workspaceId: string): Promise<void> {
  try {
    const store = resolveWorkspaceStore();
    if (store !== null) await store.delete(workspaceId);
  } catch {
    // Deletion is best-effort by design.
  }
}
