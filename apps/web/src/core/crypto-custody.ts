/**
 * Crypto custody — client-side key custody for the E2EE boundary.
 *
 * The account master key lives in a module-level single slot (one account
 * per session), unwrapped from the login response's kdf record at auth time.
 * Raw workspace keys live ONLY in this module's in-memory cache (never
 * localStorage — Review Focus 4) and are cleared on sign-out. The
 * device-local keys of offline workspaces live in IndexedDB custody
 * (Task 9, `master-key-storage.ts`) and SURVIVE session end by design: they
 * protect content sealed under them (wire/outbox envelopes), and sign-out is
 * a session boundary, not a workspace removal — clearing them would orphan
 * that content behind a fresh key (data-availability ruling). Cleanup rides
 * workspace removal only (`deleteOfflineWorkspaceKey`, F1).
 * `ensureWorkspaceKey` fetches the wrapped key (unwrap) or generates + wraps
 * + stores one (404), returning the raw 32-byte key for the worker init
 * message.
 */

import {
  exportWorkspaceKey,
  generateWorkspaceKey,
  unwrapMasterKeyWithBytes,
  unwrapWorkspaceKey,
  wrapWorkspaceKey,
  type KdfRecord,
} from "@notees/protocol";

import { fetchWorkspaceKey, storeWorkspaceKey, AuthRequestError } from "./auth-api.js";
import {
  deleteMasterKey,
  getOfflineWorkspaceKey,
  loadMasterKey,
  persistOfflineWorkspaceKey,
  storeMasterKey,
  storeMasterKeyBytes,
} from "./master-key-storage.js";

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
  // One scrypt for both faces of the key: the non-extractable handle the
  // session works with, and the raw bytes — fallback material for storage
  // layers that refuse to structured-clone a CryptoKey (Firefox + IndexedDB).
  // The bytes are handed to persistence and dropped; nothing retains them.
  const { key, bytes } = await unwrapMasterKeyWithBytes(password, kdf);
  const handle: MasterKeyHandle = { key };
  masterKeySlot = handle;
  workspaceKeyCache.clear();
  // Persist the handle so a reload within the signed-in session doesn't
  // require re-unlocking: the non-extractable CryptoKey on Chromium, the
  // raw-bytes record as the Firefox fallback. Bounded-await: the fast-path
  // write is guaranteed done before this resolves; a stall can never block
  // login/unlock past the cap. Never throws — the memory-only fallback and
  // the locked banner cover a failed write.
  await persistMasterKey(key, bytes);
  return handle;
}

/** The persistence stall cap: a slow custody store never blocks derive past this. */
const MASTER_KEY_PERSIST_TIMEOUT_MS = 1000;

/**
 * Store the derived handle with a bounded await, one warning on failure, and
 * one deferred macrotask retry (transient stalls recover silently). Fully
 * self-contained: never rejects, so deriveMasterKey's contract is unchanged.
 * `rawBytes` is the fallback material for storage layers refusing CryptoKey
 * structured-clone (Firefox); it exists only inside this call.
 */
async function persistMasterKey(key: CryptoKey, rawBytes: Uint8Array): Promise<void> {
  const warn = (error: unknown) => {
    console.warn(
      "[notees-web] master key not persisted — reloads will ask for the password again:",
      error,
    );
  };
  // Firefox refuses to structured-clone a CryptoKey into IndexedDB
  // (DataCloneError on put). After the first refusal this run switches to
  // the raw-bytes record, so the deferred retry skips the doomed put.
  let mode: "key" | "bytes" = "key";
  const attempt = async (): Promise<void> => {
    if (mode === "key") {
      try {
        await storeMasterKey(key);
        return;
      } catch {
        mode = "bytes";
      }
    }
    await storeMasterKeyBytes(rawBytes);
  };
  try {
    await Promise.race([
      attempt(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`custody store stalled past ${MASTER_KEY_PERSIST_TIMEOUT_MS}ms`)),
          MASTER_KEY_PERSIST_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (error) {
    warn(error);
    // One deferred retry on a macrotask — a transient stall (storage pressure,
    // a busy IDB transaction) recovers silently; a systemic failure (storage
    // disabled, quota) warns once more. The record write stays idempotent.
    setTimeout(() => {
      void attempt().catch(warn);
    }, 0);
  }
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
 * Non-secure contexts (plain-http LAN access) withhold Web Crypto's `subtle`
 * surface, so any keying arm would die on a raw "cannot read properties of
 * undefined". Both keying entries assert the surface first and throw this
 * honest cause instead — the boot form and the creation surfaces surface it
 * through their existing error channels.
 */
export const SECURE_CONTEXT_KEYING_COPY =
  "This browser context has no Web Crypto — use HTTPS or localhost to key a workspace.";

/** Web Crypto's `subtle` surface exists only in secure contexts. */
function assertKeyingAvailable(): void {
  if (globalThis.crypto?.subtle === undefined) throw new Error(SECURE_CONTEXT_KEYING_COPY);
}

/**
 * The wrapped key bundle a new workspace carries, or null when the session
 * is keyless (API-key sign-in) — the caller then fires the create WITHOUT a
 * bundle and the SERVER decides: the hatch on → the pinned 422
 * `keying_required` body (its own directional sentence) surfaces through the
 * caller's existing error channel; the hatch off (`NOTEES_REQUIRE_KEYED=0`)
 * → the legacy unkeyed 201. The client never pre-flights: the documented
 * escape hatch stays server-side. With the master key in memory: a fresh
 * workspace key wrapped under the master — the same generate + wrap
 * `ensureWorkspaceKey` performs on its 404 arm, minus the pre-flight PUT
 * (the bundle rides the creation payload itself; the server stores it with
 * the mint). There is no 409 to adopt against: a creation either stores its
 * bundle or the workspace does not exist.
 */
export async function keyBundleForCreate(): Promise<{ wrappedKey: string } | null> {
  const master = currentMasterKey();
  if (master === null) return null;
  // Minting needs Web Crypto: outside a secure context (plain-http LAN) the
  // honest no-Web-Crypto error names the cause — never a raw TypeError.
  assertKeyingAvailable();
  const workspaceKey = await generateWorkspaceKey();
  return { wrappedKey: await wrapWorkspaceKey(master.key, workspaceKey) };
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

/**
 * The READ-ONLY open path (keying is deliberate): fetch the wrapped key and
 * unwrap it — NEVER generate or store one. Resolves null when the server
 * holds no wrapped key (404): the workspace is plaintext and stays plaintext
 * until the user keys it (creation carries the bundle; the banner action
 * calls `ensureWorkspaceKey`). A stored key that does not open under this
 * master is a real error state (thrown, never silently degraded). Caches the
 * unwrapped key like `ensureWorkspaceKey`, so later opens and the asset path
 * reuse it without another GET.
 */
export async function readWorkspaceKey(
  serverUrl: string,
  token: string,
  workspaceId: string,
  master: MasterKeyHandle,
): Promise<Uint8Array | null> {
  const cached = workspaceKeyCache.get(workspaceId);
  if (cached !== undefined) return exportWorkspaceKey(cached);
  const wrapped = await fetchWorkspaceKey(serverUrl, token, workspaceId);
  if (wrapped === undefined) return null;
  const workspaceKey = await unwrapOrWrongMaster(master, wrapped);
  workspaceKeyCache.set(workspaceId, workspaceKey);
  return exportWorkspaceKey(workspaceKey);
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

/**
 * The device-local key of an offline workspace, restoring it from custody or
 * GENERATING + persisting one when custody is empty (Task 9). This is
 * CREATION-time keying — the "Work offline" workspace is born keyed — not
 * the open-time keying the no-auto-key ruling forbids. Deliberately does NOT
 * touch `workspaceKeyCache`: the cache belongs to the server read path (a
 * cached device key would suppress the first-sync wrap publish), and custody
 * itself is the offline cache. A persist failure warns and still returns the
 * session key — the content seals for this session; the next open retries.
 * Records survive session end by design (no account owns them — the key
 * protects content sealed under it); cleanup rides workspace removal only
 * (`deleteOfflineWorkspaceKey`, F1).
 */
export async function ensureOfflineWorkspaceKey(workspaceId: string): Promise<Uint8Array> {
  const existing = await getOfflineWorkspaceKey(workspaceId);
  if (existing !== null) return exportWorkspaceKey(existing);
  // Minting needs Web Crypto: outside a secure context (plain-http LAN) the
  // honest no-Web-Crypto error names the cause — never a raw TypeError.
  assertKeyingAvailable();
  const key = await generateWorkspaceKey();
  try {
    await persistOfflineWorkspaceKey(workspaceId, key);
  } catch (error) {
    console.warn(
      "[notees-web] offline workspace key not persisted — reloads will open this workspace keyless:",
      error,
    );
  }
  return exportWorkspaceKey(key);
}

/** Drop the raw workspace keys (keeps the master key — a per-workspace refresh). */
export function clearWorkspaceKeys(): void {
  workspaceKeyCache.clear();
}

/** Full custody reset: master key + every raw workspace key + the persisted
 * handle. Called on sign-out (and every other session end) — the persisted
 * record is deleted too, so the next session reverts to the password. The
 * offline workspace-key records are deliberately NOT touched: they protect
 * content sealed under them and belong to the workspace, not the session
 * (see the module header). */
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
