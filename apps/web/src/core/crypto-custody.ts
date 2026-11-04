/**
 * Crypto custody — client-side key custody for the E2EE boundary.
 *
 * The account master key lives in a module-level single slot (one account
 * per session), unwrapped from the login response's kdf record at auth time.
 * Raw workspace keys live ONLY in this module's in-memory cache (never
 * localStorage — Review Focus 4) and are cleared on sign-out. `ensureWorkspaceKey`
 * fetches the wrapped key (unwrap) or generates + wraps + stores one (404),
 * returning the raw 32-byte key for the worker init message.
 */

import {
  exportWorkspaceKey,
  generateWorkspaceKey,
  unwrapMasterKey,
  unwrapWorkspaceKey,
  wrapWorkspaceKey,
  type KdfRecord,
} from "@notees/protocol";

import { fetchWorkspaceKey, storeWorkspaceKey, AuthRequestError } from "./auth-api.js";
import { deleteMasterKey, loadMasterKey, storeMasterKey } from "./master-key-storage.js";

/** Opaque handle on the account master key (one per session). */
export interface MasterKeyHandle {
  readonly key: CryptoKey;
}

let masterKeySlot: MasterKeyHandle | null = null;
/** Raw workspace keys, in memory only, keyed by workspace id. */
const workspaceKeyCache = new Map<string, CryptoKey>();
/** In-flight ensure flights, keyed by workspace id: concurrent first-opens
 * share ONE flight (first write wins server-side, so they converge on the
 * same key instead of racing two PUTs). */
const inFlightEnsures = new Map<string, Promise<Uint8Array>>();

/**
 * Unwrap the account master key from the login kdf record. Throws at the
 * verifier on a wrong password (Review Focus 2: the failure surfaces as a
 * login error, never a silent custody skip). Holds the key in the session
 * slot, replacing any previous account's key.
 */
export async function deriveMasterKey(password: string, kdf: KdfRecord): Promise<MasterKeyHandle> {
  const key = await unwrapMasterKey(password, kdf);
  const handle: MasterKeyHandle = { key };
  masterKeySlot = handle;
  workspaceKeyCache.clear();
  // Persist the non-extractable handle so a reload within the signed-in
  // session doesn't require re-unlocking. Best-effort: the memory-only
  // fallback and the locked banner cover a failed write.
  void storeMasterKey(key).catch(() => {});
  return handle;
}

/**
 * Re-hydrate the master key slot from IndexedDB after a reload (boot session
 * validation, session-credential path only). Fully silent: no record, a
 * missing IndexedDB, or a corrupt read all leave the slot untouched (the
 * locked banner covers it). Returns whether the slot was restored.
 */
export async function restoreMasterKeyFromStorage(): Promise<boolean> {
  try {
    const key = await loadMasterKey();
    if (key === null) return false;
    masterKeySlot = { key };
    workspaceKeyCache.clear();
    return true;
  } catch {
    return false;
  }
}

/** The session's master key, or null when the session is keyless (API-key sign-in). */
export function currentMasterKey(): MasterKeyHandle | null {
  return masterKeySlot;
}

/**
 * The workspace's raw 32-byte key: fetch + unwrap when the server holds a
 * wrapped key; generate + wrap + store when keyless (404). Concurrent calls
 * for the same workspace share one flight. A PUT rejected with 409 (first
 * write wins — a concurrent device stored its key first) re-fetches the
 * winner's key and unwraps THAT; a stored key that does not open under this
 * master is a real error state (thrown, never silently degraded).
 */
export async function ensureWorkspaceKey(
  serverUrl: string,
  token: string,
  workspaceId: string,
  master: MasterKeyHandle,
): Promise<Uint8Array> {
  const cached = workspaceKeyCache.get(workspaceId);
  if (cached !== undefined) return exportWorkspaceKey(cached);
  const shared = inFlightEnsures.get(workspaceId);
  if (shared !== undefined) return shared;
  const flight = ensureWorkspaceKeyFlight(serverUrl, token, workspaceId, master).finally(() => {
    inFlightEnsures.delete(workspaceId);
  });
  inFlightEnsures.set(workspaceId, flight);
  return flight;
}

async function ensureWorkspaceKeyFlight(
  serverUrl: string,
  token: string,
  workspaceId: string,
  master: MasterKeyHandle,
): Promise<Uint8Array> {
  const wrapped = await fetchWorkspaceKey(serverUrl, token, workspaceId);
  let workspaceKey: CryptoKey;
  if (wrapped === undefined) {
    workspaceKey = await generateWorkspaceKey();
    try {
      await storeWorkspaceKey(
        serverUrl,
        token,
        workspaceId,
        await wrapWorkspaceKey(master.key, workspaceKey),
      );
    } catch (error) {
      // First write wins: 409 means a concurrent device stored its key
      // first — adopt the winner's key instead of splitting the workspace.
      if (error instanceof AuthRequestError && error.status === 409) {
        const winner = await fetchWorkspaceKey(serverUrl, token, workspaceId);
        if (winner === undefined) {
          throw new Error("workspace key disappeared between the 409 and the re-fetch");
        }
        workspaceKey = await unwrapOrWrongMaster(master, winner);
      } else {
        throw error;
      }
    }
  } else {
    workspaceKey = await unwrapOrWrongMaster(master, wrapped);
  }
  workspaceKeyCache.set(workspaceId, workspaceKey);
  return exportWorkspaceKey(workspaceKey);
}

async function unwrapOrWrongMaster(master: MasterKeyHandle, wrapped: string): Promise<CryptoKey> {
  try {
    return await unwrapWorkspaceKey(master.key, wrapped);
  } catch {
    throw new Error(
      "wrong master key for this workspace: the stored key was wrapped for a different account password",
    );
  }
}

/**
 * The cached raw workspace key for a workspace, or null when keyless/locked/
 * not-yet-resolved. Memory-only, main-thread (the asset REST channel never
 * enters the worker, so both store modes resolve through here).
 */
export async function getCachedWorkspaceKey(workspaceId: string): Promise<Uint8Array | null> {
  const cached = workspaceKeyCache.get(workspaceId);
  if (cached === undefined) return null;
  return exportWorkspaceKey(cached);
}

/** Drop the raw workspace keys (keeps the master key — a per-workspace refresh). */
export function clearWorkspaceKeys(): void {
  workspaceKeyCache.clear();
}

/** Full custody reset: master key + every raw workspace key + the persisted
 * handle. Called on sign-out (and every other session end) — the persisted
 * record is deleted too, so the next session reverts to the password. */
export function clearCryptoCustody(): Promise<void> {
  masterKeySlot = null;
  workspaceKeyCache.clear();
  return deleteMasterKey();
}

/** Test seam: clear the in-memory slot only (simulates a reload with the
 * IndexedDB record still present). */
export function __clearMasterKeySlotForTests(): void {
  masterKeySlot = null;
}
