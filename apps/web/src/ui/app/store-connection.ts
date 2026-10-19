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

import { WorkspaceClient } from "@/core/workspace-client.js";
import { WorkerClient } from "@/core/worker-client.js";
import { markLocalWorkspaceCopy } from "@/core/workspace-registry.js";
import { settingsSectionFromPath } from "../components/SettingsPage.js";
import { navFromPath } from "./routing.js";
import { STORAGE_KEYS, clearStored, writeStored } from "./storage.js";
import { detectStoreMode, type StoreMode } from "./storeMode.js";
import type { AnyClient } from "./clients.js";

export type CredentialType = "session" | "apikey";

export interface ConnectOptions {
  isOffline: boolean;
  credentialType: CredentialType;
  label?: string;
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
  writeStored(STORAGE_KEYS.serverUrl, url);
  writeStored(STORAGE_KEYS.workspaceId, workspaceId);
  const mode = detectStoreMode();
  let nextClient: AnyClient;
  if (mode === "worker") {
    nextClient = await WorkerClient.create(
      options.isOffline
        ? { serverUrl: "", apiKey: "", workspaceId, sqlWasmUrl, offline: true }
        : { serverUrl: url, apiKey: credential, workspaceId, sqlWasmUrl },
    );
  } else {
    nextClient = options.isOffline
      ? await WorkspaceClient.createOffline({ workspaceId, sqlJsConfig: { locateFile: () => sqlWasmUrl } })
      : await WorkspaceClient.createHttp({
          serverUrl: url,
          apiKey: credential,
          workspaceId,
          sqlJsConfig: { locateFile: () => sqlWasmUrl },
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
  return { client: nextClient, mode, sessionSignedIn, workspaceName: options.label ?? "Workspace" };
}
