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

import { fetchWorkspaceKey, storeWorkspaceKey } from "./auth-api.js";

/** Opaque handle on the account master key (one per session). */
export interface MasterKeyHandle {
  readonly key: CryptoKey;
}

let masterKeySlot: MasterKeyHandle | null = null;
/** Raw workspace keys, in memory only, keyed by workspace id. */
const workspaceKeyCache = new Map<string, CryptoKey>();

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
  return handle;
}

/** The session's master key, or null when the session is keyless (API-key sign-in). */
export function currentMasterKey(): MasterKeyHandle | null {
  return masterKeySlot;
}

/**
 * The workspace's raw 32-byte key: fetch + unwrap when the server holds a
 * wrapped key; generate + wrap + store when keyless (404). Throws a clear
 * error when the stored key does not open under this master key (a key
 * wrapped for a different account password).
 */
export async function ensureWorkspaceKey(
  serverUrl: string,
  token: string,
  workspaceId: string,
  master: MasterKeyHandle,
): Promise<Uint8Array> {
  const cached = workspaceKeyCache.get(workspaceId);
  if (cached !== undefined) return exportWorkspaceKey(cached);

  const wrapped = await fetchWorkspaceKey(serverUrl, token, workspaceId);
  let workspaceKey: CryptoKey;
  if (wrapped === undefined) {
    workspaceKey = await generateWorkspaceKey();
    await storeWorkspaceKey(serverUrl, token, workspaceId, await wrapWorkspaceKey(master.key, workspaceKey));
  } else {
    try {
      workspaceKey = await unwrapWorkspaceKey(master.key, wrapped);
    } catch {
      throw new Error(
        "wrong master key for this workspace: the stored key was wrapped for a different account password",
      );
    }
  }
  workspaceKeyCache.set(workspaceId, workspaceKey);
  return exportWorkspaceKey(workspaceKey);
}

/** Drop the raw workspace keys (keeps the master key — a per-workspace refresh). */
export function clearWorkspaceKeys(): void {
  workspaceKeyCache.clear();
}

/** Full custody reset: master key + every raw workspace key. Called on sign-out. */
export function clearCryptoCustody(): void {
  masterKeySlot = null;
  workspaceKeyCache.clear();
}
