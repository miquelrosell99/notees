/**
 * store-connection — the framework-free connection core.
 *
 * The body of the App's connect path minus React state: server/workspace
 * persistence, the WorkerClient-vs-WorkspaceClient decision by store mode,
 * the local-first bootstrapWorkspace swallow, credential persistence
 * decisions, the boot-path keep/rewrite, and the offline-registry write.
 * The caller (useWorkspaceConnection) applies the outcome to React state
 * and owns the realtime start + teardown.
 */

import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import sqliteWasmUrl from "@sqlite.org/sqlite-wasm/sqlite3.wasm?url";

import { WorkspaceClient } from "@/core/workspace-client/index.js";
import {
  clearWorkspaceKeys,
  currentMasterKey,
  ensureWorkspaceKey,
} from "@/core/crypto-custody.js";
import { AuthRequestError, fetchWorkspaceKey, listWorkspaces, type WorkspaceEntry } from "@/core/auth-api.js";
import { WorkerClient } from "@/core/worker-client.js";
import { markLocalWorkspaceCopy } from "@/core/workspace-registry.js";
import { settingsSectionFromPath } from "../../features/settings/SettingsPage.js";
import { navFromPath } from "./routing.js";
import { STORAGE_KEYS, clearStored, readStored, writeStored } from "./storage.js";
import { detectStoreMode, type StoreMode } from "./storeMode.js";
import type { AnyClient } from "./clients.js";

export type CredentialType = "session" | "apikey";

export interface ConnectOptions {
  isOffline: boolean;
  credentialType: CredentialType;
  label?: string;
  /**
   * Engine sync-phase messages during the open ("Fetching latest snapshot…",
   * "Catching up… N operations", "Synced") — the connecting screen renders
   * them as progress.
   */
  onSyncPhase?: ((phase: string, message: string) => void) | undefined;
  /**
   * Engine catch-up progress ({applied, total} per page) — the connecting
   * screen renders it as a progress bar + percentage.
   */
  onSyncProgress?: ((applied: number, total: number) => void) | undefined;
}

/** What the caller applies to React state once the store has opened. */
export interface ConnectOutcome {
  client: AnyClient;
  mode: StoreMode;
  /** True when the live credential is a session (API-key management needs one). */
  sessionSignedIn: boolean;
  workspaceName: string;
}

/**
 * Fail-loud open refusal: the workspace is encrypted and this session holds
 * no master key. Thrown BEFORE any client is created or storage is written —
 * a keyed workspace never opens keyless. The caller surfaces the unlock
 * re-prompt (re-login re-derives the master key, then re-opens).
 */
export class EncryptedWorkspaceLockedError extends Error {
  constructor(readonly workspaceId: string) {
    super("This workspace is encrypted — enter your password to open it.");
    this.name = "EncryptedWorkspaceLockedError";
  }
}

/**
 * E2EE custody, unconditional: hand the workspace key to the client whenever
 * this session can unwrap one. The `window.NOTEES_CONFIG.e2ee` kill switch
 * retired — keying no longer gates on a flag (the typed flag stays for
 * container compat, inert).
 *
 * Offline workspaces are keyless by design (no server → no keys →
 * plaintext). With a session but NO master key in memory (a reload restored
 * the session without it — custody is memory-only), a keyed workspace
 * reports `locked` and the OPEN FAILS LOUDLY (fail-loud ruling: never open
 * keyless) — the UI shows the unlock re-prompt instead; a session WITH the
 * master key whose stored key fails to unwrap under it (e.g. the account
 * password changed on another device) fails loud the same way. API-key
 * sessions cannot unwrap (the key route is user custody) — the workspaces
 * listing's `encrypted` flag decides there.
 */
export interface WorkspaceKeyResolution {
  /** The raw 32-byte workspace key, when this open is sealed. */
  key: Uint8Array | undefined;
  /** The workspace IS encrypted and this session cannot supply the key. */
  locked: boolean;
}

export async function resolveWorkspaceKey(
  url: string,
  credential: string,
  workspaceId: string,
  options: ConnectOptions,
): Promise<WorkspaceKeyResolution> {
  if (options.isOffline) return { key: undefined, locked: false };
  const master = currentMasterKey();
  if (master !== null) {
    try {
      return { key: await ensureWorkspaceKey(url, credential, workspaceId, master), locked: false };
    } catch (error) {
      console.warn(
        `[notees-web] workspace key unavailable for ${workspaceId}; refusing the open (fail loud):`,
        error instanceof Error ? error.message : String(error),
      );
      // A wrong-master/unwrap failure proves the workspace is keyed; a
      // network failure does not — probe before reporting "locked". When
      // the original failure was NOT an HTTP error (a crypto/unwrap failure)
      // and the probe cannot settle it, default to locked so the open never
      // degrades silently without the unlock re-prompt.
      const wrapped = await fetchWorkspaceKey(url, credential, workspaceId).catch(() => undefined);
      if (wrapped !== undefined) return { key: undefined, locked: true };
      const locked = !(error instanceof AuthRequestError);
      return { key: undefined, locked };
    }
  }
  if (options.credentialType === "session") {
    // Distinguish "keyed but locked" from "keyless" for the unlock modal: the
    // wrapped-key row needs only membership, not the master key.
    const wrapped = await fetchWorkspaceKey(url, credential, workspaceId).catch(() => undefined);
    if (wrapped !== undefined) return { key: undefined, locked: true };
    return { key: undefined, locked: false };
  }
  // API-key session: no password path and the key route is user custody (the
  // operator key gets 403) — the workspaces listing carries the encrypted
  // flag instead. A keyed workspace refuses the open; the modal copy directs
  // to signing in with email + password.
  const listing = await listWorkspaces(url, credential).catch(() => ({ workspaces: [] as WorkspaceEntry[] }));
  const encrypted = listing.workspaces.find((entry) => entry.id === workspaceId)?.encrypted === true;
  return { key: undefined, locked: encrypted };
}

/**
 * Boot a client for `workspaceId`. `credential` is the session token (or
 * operator API key); `isOffline` builds an OfflineTransport instead. The
 * worker store is keyed by workspace id, so adopting "this device's"
 * offline workspace later reuses the same OPFS file and its unpushed
 * backlog drains through the normal outbox push.
 */
export async function openStoreConnection(
  url: string,
  credential: string,
  workspaceId: string,
  options: ConnectOptions,
): Promise<ConnectOutcome> {
  // Key custody resolves BEFORE anything is persisted: a keyed workspace
  // without a key fails loud here — no client, no storage writes, nothing —
  // and the caller surfaces the unlock re-prompt.
  const resolution = await resolveWorkspaceKey(url, credential, workspaceId, options);
  if (resolution.locked) throw new EncryptedWorkspaceLockedError(workspaceId);
  const workspaceKey = resolution.key;
  // Workspace switch: drop the previous workspace's raw keys from the
  // in-memory cache (the master key stays). The per-workspace cache would
  // otherwise hold keys for every workspace opened this session; on a switch
  // the old keys are dead weight and a same-workspace re-open re-derives
  // them from the wrapped row anyway.
  const previousWorkspaceId = readStored(STORAGE_KEYS.workspaceId);
  if (previousWorkspaceId !== "" && previousWorkspaceId !== workspaceId) {
    clearWorkspaceKeys();
  }
  writeStored(STORAGE_KEYS.serverUrl, url);
  writeStored(STORAGE_KEYS.workspaceId, workspaceId);
  const mode = detectStoreMode();
  let nextClient: AnyClient;
  if (mode === "worker") {
    nextClient = await WorkerClient.create(
      options.isOffline
        ? { serverUrl: "", apiKey: "", workspaceId, sqlWasmUrl, sqliteWasmUrl, offline: true }
        : {
            serverUrl: url,
            apiKey: credential,
            workspaceId,
            sqlWasmUrl,
            sqliteWasmUrl,
            ...(workspaceKey !== undefined ? { workspaceKey } : {}),
            ...(options.onSyncPhase !== undefined ? { onSyncPhase: options.onSyncPhase } : {}),
            ...(options.onSyncProgress !== undefined ? { onSyncProgress: options.onSyncProgress } : {}),
          },
    );
  } else {
    nextClient = options.isOffline
      ? await WorkspaceClient.createOffline({ workspaceId, sqlJsConfig: { locateFile: () => sqlWasmUrl } })
      : await WorkspaceClient.createHttp({
          serverUrl: url,
          apiKey: credential,
          workspaceId,
          sqlJsConfig: { locateFile: () => sqlWasmUrl },
          ...(workspaceKey !== undefined ? { workspaceKey } : {}),
          ...(options.onSyncPhase !== undefined ? { onSyncPhase: options.onSyncPhase } : {}),
          ...(options.onSyncProgress !== undefined ? { onSyncProgress: options.onSyncProgress } : {}),
        });
    // The worker path bootstraps during init; the in-process path syncs
    // here. Local-first on both: an unreachable relay must not block boot
    // from local bytes (WorkerCore.create already swallows the same
    // failure) — the sync error surfaces through the status callbacks and
    // the realtime reconnect catches up on recovery.
    try {
      await nextClient.bootstrapWorkspace(workspaceId);
    } catch {
      // Working locally until the server recovers.
    }
  }
  let sessionSignedIn = false;
  if (options.credentialType === "session") {
    writeStored(STORAGE_KEYS.sessionToken, credential);
    clearStored(STORAGE_KEYS.apiKey);
    sessionSignedIn = true;
  } else if (options.credentialType === "apikey") {
    writeStored(STORAGE_KEYS.apiKey, credential);
    clearStored(STORAGE_KEYS.sessionToken);
  }
  // Keep meaningful URLs across connect: a hub route (/journal, /inbox, …),
  // a node deep link, the full-page search, or a settings section
  // (/settings/<section>) survives workspace (re)connects; anything else
  // (e.g. /workspaces after entering) resolves to the app root. replaceState
  // (no new entry): the manager's landing navigation owns the history slot.
  const bootPath = window.location.pathname;
  const keepPath =
    navFromPath(bootPath) !== null ||
    bootPath === "/search" ||
    settingsSectionFromPath(bootPath) !== null ||
    /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bootPath);
  window.history.replaceState({ view: "app" }, "", keepPath ? bootPath : "/");
  // The boot reached local bytes: this device now holds a copy of the
  // workspace, so the offline registry may offer it while the server
  // can't answer.
  markLocalWorkspaceCopy(workspaceId);
  return {
    client: nextClient,
    mode,
    sessionSignedIn,
    workspaceName: options.label ?? "Workspace",
  };
}
