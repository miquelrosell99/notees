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
import { AuthRequestError, createWorkspace, fetchWorkspaceKey, listWorkspaces, storeWorkspaceKey, type WorkspaceEntry } from "@/core/auth-api.js";
import { getOfflineWorkspaceKey } from "@/core/master-key-storage.js";
import { WorkerClient } from "@/core/worker-client.js";
import { markLocalWorkspaceCopy } from "@/core/workspace-registry.js";
import { localStoreHasContent } from "./local-store-content.js";
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
   * F2 decline: the user saw the adoption offer and kept the workspace local.
   * The open then proceeds plaintext with ZERO writes (no create, no PUT) —
   * "nothing changes". Without this the 404 + custody + non-empty arm would
   * pause the open on the offer again.
   */
  declinedAdoption?: boolean;
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
  /**
   * Positive knowledge that the opened workspace carries no wrapped key (the
   * key route 404'd, or an API-key session's listing row reports
   * `encrypted: false`). Drives the not-encrypted banner — never guessed, so
   * a false here (keyed, offline, or indeterminate) means NO banner.
   */
  workspacePlaintext: boolean;
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
 * The F2 adoption-offer pause: an offline-created workspace (custody holds
 * its device key, the local store holds content) opened online against a
 * server that has never seen it (the key route 404'd, or — API-key sessions —
 * the listing positively reported the server does not know it). Thrown
 * BEFORE any client is created or storage is written; the App surfaces the
 * offer modal and either confirms (`confirmWorkspaceAdoption` + reconnect)
 * or declines (`declinedAdoption` → plaintext). Carries everything the
 * modal + reconnect need, self-contained like `UnlockRequest`.
 */
export class AdoptionOfferError extends Error {
  constructor(
    readonly url: string,
    readonly credential: string,
    readonly workspaceId: string,
    /** The workspace's display name (Error.name stays the class name). */
    readonly workspaceName: string,
    readonly credentialType: CredentialType,
  ) {
    super("This workspace exists only on this device — offer to publish it to the server.");
    this.name = "AdoptionOfferError";
  }
}

/**
 * The adoption confirm needs a master key to wrap the device key under — an
 * API-key session (or a session whose master key is gone from memory) has no
 * password path to one. The modal shows this as its directional copy with the
 * confirm disabled; `confirmWorkspaceAdoption` throws it as the honest cause
 * rather than dying on a raw wrap.
 */
export const ADOPTION_NEEDS_PASSWORD_COPY =
  "Publishing needs the account master key — sign out and sign in with your email and password, then open this workspace again.";

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
 * indeterminate (never locked, never plaintext).
 *
 * The offline→online adoption offer (F2) rides the online 404 arm below: an
 * offline-created workspace opened online against a server that has never
 * seen it (the key route 404s) with content in the local store pauses the
 * open on an OFFER to publish — never a bare refusal, never a silent
 * auto-publish. Confirming POSTs the workspace CREATE under its EXISTING id
 * with the custody device key's wrap under the master (publish-not-mint, the
 * T9 invariant — `confirmWorkspaceAdoption`); the App then reconnects and the
 * outbox backlog drains sealed. The create's 409 (the workspace is somehow
 * server-known-but-keyless) falls back to the established key PUT. Declining
 * opens plaintext (`declinedAdoption`) with zero writes; an EMPTY local store
 * has nothing to publish and opens plaintext per the normal flow.
 *
 * With a session but NO master key in memory (a reload restored the session
 * without it — custody is memory-only), a keyed workspace reports `locked`
 * and the OPEN FAILS LOUDLY (fail-loud ruling: never open keyless) — the UI
 * shows the unlock re-prompt instead; a session WITH the master key whose
 * stored key fails to unwrap under it (e.g. the account password changed on
 * another device) fails loud the same way. API-key sessions cannot unwrap
 * (the key route is user custody) — the workspaces listing's `encrypted`
 * flag decides there; when the listing positively reports the server does
 * not know the workspace, the same adoption offer surfaces with the
 * directional copy (confirm needs a master key — disabled).
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
      // offline, its content is sealed with the device-local key — the open
      // pauses on the F2 adoption offer when the local store has content
      // (confirming publishes the device key's wrap under the master, see
      // confirmWorkspaceAdoption); empty custody means a genuinely keyless
      // workspace → plaintext per the normal flow.
      if (raw === null) {
        const deviceKey = await getOfflineWorkspaceKey(workspaceId);
        if (deviceKey === null) return { key: undefined, locked: false, plaintext: true };
        if (!(await localStoreHasContent(workspaceId))) {
          // An empty offline workspace has nothing to publish — the normal
          // plaintext flow (the not-encrypted banner offers keying instead).
          return { key: undefined, locked: false, plaintext: true };
        }
        if (options.declinedAdoption !== true) {
          throw new AdoptionOfferError(
            url,
            credential,
            workspaceId,
            options.label ?? "Workspace",
            options.credentialType,
          );
        }
        return { key: undefined, locked: false, plaintext: true };
      }
      return { key: raw, locked: false, plaintext: false };
    } catch (error) {
      if (error instanceof AdoptionOfferError) throw error;
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
  let listing: { workspaces: WorkspaceEntry[] } | null = null;
  try {
    listing = await listWorkspaces(url, credential);
  } catch {
    // Unreachable ≠ unknown: without a server answer a listing miss is not
    // positive knowledge, so no adoption offer may fire on this arm.
    listing = null;
  }
  const entry = listing?.workspaces.find((item) => item.id === workspaceId);
  const encrypted = entry?.encrypted === true;
  if (listing !== null && entry === undefined) {
    // The server answered and does not know this workspace: an offline-created
    // workspace with local content earns the adoption offer — the apikey arm
    // renders it with the directional copy and the confirm disabled (no
    // master key exists to wrap under).
    const deviceKey = await getOfflineWorkspaceKey(workspaceId);
    if (
      deviceKey !== null &&
      options.declinedAdoption !== true &&
      (await localStoreHasContent(workspaceId))
    ) {
      throw new AdoptionOfferError(
        url,
        credential,
        workspaceId,
        options.label ?? "Workspace",
        options.credentialType,
      );
    }
  }
  return {
    key: undefined,
    locked: encrypted,
    plaintext: entry !== undefined && !encrypted,
  };
}

/**
 * The adoption OFFER's confirm arm (F2): publish an offline-created workspace
 * to the server. POSTs the workspace CREATE under its EXISTING id with the
 * custody device key's wrap under the master — publish-not-mint (the T9
 * invariant: the key already exists, nothing is generated). The create's 409
 * (the id is taken — the workspace is server-known-but-keyless, e.g. adopted
 * earlier by a relay write) falls back to the established key PUT, the F1
 * publish path. The caller reconnects on success so the open re-resolves as a
 * normal keyed open and the outbox backlog drains sealed.
 */
export async function confirmWorkspaceAdoption(
  url: string,
  credential: string,
  workspaceId: string,
  name: string,
): Promise<void> {
  const master = currentMasterKey();
  if (master === null) throw new Error(ADOPTION_NEEDS_PASSWORD_COPY);
  const deviceKey = await getOfflineWorkspaceKey(workspaceId);
  if (deviceKey === null) {
    throw new Error("This workspace has no device-local key to publish.");
  }
  const wrapped = await wrapWorkspaceKey(master.key, deviceKey);
  try {
    await createWorkspace(url, credential, name, wrapped, workspaceId);
  } catch (error) {
    if (error instanceof AuthRequestError && error.status === 409) {
      // Server-known-but-keyless: the create cannot adopt the id; publish the
      // wrap onto the existing row instead (the established PUT path).
      await storeWorkspaceKey(url, credential, workspaceId, wrapped);
      return;
    }
    throw error;
  }
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
    workspacePlaintext: resolution.plaintext,
  };
}
