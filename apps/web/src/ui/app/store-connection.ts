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

import { exportWorkspaceKey, wrapWorkspaceKey } from "@notees/protocol";

import { WorkspaceClient } from "@/core/workspace-client/index.js";
import {
  clearWorkspaceKeys,
  currentMasterKey,
  readWorkspaceKey,
} from "@/core/crypto-custody.js";
import { AuthRequestError, fetchWorkspaceKey, listWorkspaces, storeWorkspaceKey, type WorkspaceEntry } from "@/core/auth-api.js";
import { getOfflineWorkspaceKey } from "@/core/master-key-storage.js";
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
 * E2EE custody, unconditional and READ-ONLY on the open path. The
 * `window.NOTEES_CONFIG.e2ee` kill switch retired — keying no longer gates on
 * a flag (the typed flag stays for container compat, inert). Keying itself is
 * DELIBERATE: opening fetches the wrapped key and unwraps it — a plaintext
 * workspace (GET 404) opens with no key and the client NEVER lazy-stores one.
 * The only writers are creation (the bundle rides the create payload) and the
 * banner action (Task 10 calls `ensureWorkspaceKey` directly).
 *
 * Offline workspaces (Task 9) are keyed at CREATION: the "Work offline"
 * bootstrap generates a device-local key and persists it in IndexedDB custody
 * (`master-key-storage.ts`, store `workspaceKeys`) before connecting, so the
 * open here RESTORES that key — locked is impossible (the key is
 * device-local, there is nothing to unwrap). Empty custody opens keyless,
 * indeterminate (never locked, never plaintext). The ONE open-path PUT the
 * read-only ruling sanctions rides the online 404 arm below: an
 * offline-created workspace opened online with a password session PUBLISHES
 * the existing device key's wrap under the master — first password-session
 * sync — so every device can unwrap it. Nothing is generated on open.
 *
 * With a session but NO master key in memory (a reload restored the session
 * without it — custody is memory-only), a keyed workspace reports `locked`
 * and the OPEN FAILS LOUDLY (fail-loud ruling: never open keyless) — the UI
 * shows the unlock re-prompt instead; a session WITH the master key whose
 * stored key fails to unwrap under it (e.g. the account password changed on
 * another device) fails loud the same way. API-key sessions cannot unwrap
 * (the key route is user custody) — the workspaces listing's `encrypted`
 * flag decides there.
 */
export interface WorkspaceKeyResolution {
  /** The raw 32-byte workspace key, when this open is sealed. */
  key: Uint8Array | undefined;
  /** The workspace IS encrypted and this session cannot supply the key. */
  locked: boolean;
  /**
   * The workspace carries NO wrapped key — it is plaintext and opens without
   * one. Set only on positive knowledge (the key route answered 404, or an
   * API-key session's listing row reports `encrypted: false`); never guessed,
   * so the Task-10 keying banner can trust it.
   */
  plaintext: boolean;
}

export async function resolveWorkspaceKey(
  url: string,
  credential: string,
  workspaceId: string,
  options: ConnectOptions,
): Promise<WorkspaceKeyResolution> {
  if (options.isOffline) {
    // Device-local custody (Task 9): the offline workspace's key was
    // generated at creation and lives in IndexedDB beside the master record.
    // Locked is impossible — nothing to unwrap. Empty custody (persist
    // failed at creation, or a pre-Task-9 workspace) opens keyless,
    // indeterminate.
    const restored = await getOfflineWorkspaceKey(workspaceId);
    if (restored === null) return { key: undefined, locked: false, plaintext: false };
    return { key: await exportWorkspaceKey(restored), locked: false, plaintext: false };
  }
  const master = currentMasterKey();
  if (master !== null) {
    try {
      const raw = await readWorkspaceKey(url, credential, workspaceId, master);
      // 404: the server holds no wrap. If THIS DEVICE created the workspace
      // offline, its content is sealed with the device-local key — the first
      // password-session sync PUBLISHES that key's wrap under the master (the
      // key already exists; nothing is generated on open) and the open rides
      // the device key, before any backlog pushes sealed.
      if (raw === null) {
        const deviceKey = await getOfflineWorkspaceKey(workspaceId);
        if (deviceKey === null) return { key: undefined, locked: false, plaintext: true };
        try {
          await storeWorkspaceKey(
            url,
            credential,
            workspaceId,
            await wrapWorkspaceKey(master.key, deviceKey),
          );
        } catch (error) {
          // Local-first: a failed publish must not block the open — the local
          // content seals with the device key either way, and the PUT retries
          // on the next session (the server still 404s until one lands).
          console.warn(
            `[notees-web] workspace ${workspaceId}: wrap upload failed; retrying on the next sync:`,
            error instanceof Error ? error.message : String(error),
          );
        }
        return { key: await exportWorkspaceKey(deviceKey), locked: false, plaintext: false };
      }
      return { key: raw, locked: false, plaintext: false };
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
      if (wrapped !== undefined) return { key: undefined, locked: true, plaintext: false };
      const locked = !(error instanceof AuthRequestError);
      return { key: undefined, locked, plaintext: false };
    }
  }
  if (options.credentialType === "session") {
    // Distinguish "keyed but locked" from "keyless" for the unlock modal: the
    // wrapped-key row needs only membership, not the master key.
    const wrapped = await fetchWorkspaceKey(url, credential, workspaceId).catch(() => undefined);
    if (wrapped !== undefined) return { key: undefined, locked: true, plaintext: false };
    return { key: undefined, locked: false, plaintext: true };
  }
  // API-key session: no password path and the key route is user custody (the
  // operator key gets 403) — the workspaces listing carries the encrypted
  // flag instead. A keyed workspace refuses the open; the modal copy directs
  // to signing in with email + password.
  const listing = await listWorkspaces(url, credential).catch(() => ({ workspaces: [] as WorkspaceEntry[] }));
  const entry = listing.workspaces.find((item) => item.id === workspaceId);
  const encrypted = entry?.encrypted === true;
  return { key: undefined, locked: encrypted, plaintext: entry !== undefined && !encrypted };
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
        ? {
            serverUrl: "",
            apiKey: "",
            workspaceId,
            sqlWasmUrl,
            sqliteWasmUrl,
            offline: true,
            // Offline workspaces are keyed at rest (Task 9): the restored
            // device-local key rides the init message exactly like the
            // online path.
            ...(workspaceKey !== undefined ? { workspaceKey } : {}),
          }
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
      ? await WorkspaceClient.createOffline({
          workspaceId,
          sqlJsConfig: { locateFile: () => sqlWasmUrl },
          // Offline workspaces are keyed at rest (Task 9): the restored
          // device-local key threads into the engine's crypto provider
          // exactly like the online path.
          ...(workspaceKey !== undefined ? { workspaceKey } : {}),
        })
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
