/**
 * useBootFlow — the boot flow: server probe → setup/login/signup →
 * workspace manager entry, plus the remembered-session resume effect and
 * "Work offline".
 *
 * Composition root of the boot domains: the probe path (server URL,
 * signup flag, hint + suggestion) lives in useServerProbe; the credential
 * path (account form fields, auth tab, user/token identity, the
 * setup/login/signup/API-key submits with session persistence) lives in
 * useAuthFlow. This hook owns what remains: the workspace list, the
 * remembered-session/API-key resume effect (deep links, offline fallback),
 * and the work-offline handler. App consumes the composed flow and hands
 * it to BootForm; the shell reads the account state (user/token/serverUrl)
 * from the returned flow.
 */

import { useEffect, useState } from "react";

import {
  AuthRequestError,
  fetchMe,
  fetchNodeLocation,
  listWorkspaces,
  type WorkspaceEntry,
} from "@/core/auth-api.js";
import { rememberedWorkspaceName, rememberWorkspaceList } from "@/core/workspace-registry.js";
import { STORAGE_KEYS, clearStored, readStored, writeStored } from "./storage.js";
import type { CredentialType } from "./store-connection.js";
import { useAuthFlow, type AuthFlow } from "./useAuthFlow.js";
import { useServerProbe, type ServerProbe } from "./useServerProbe.js";
import type { WorkspaceConnection } from "./useWorkspaceConnection.js";

export interface BootFlow extends ServerProbe, AuthFlow {
  workspaces: WorkspaceEntry[];
  handleWorkOffline: () => Promise<void>;
}

export function useBootFlow(
  conn: WorkspaceConnection,
  pushNav: (url: string, state: Record<string, unknown>) => void,
): BootFlow {
  const { connect, setPhase, setSessionSignedIn } = conn;
  const probe = useServerProbe(conn);
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const auth = useAuthFlow({
    conn,
    serverUrl: probe.serverUrl,
    setServerUrl: probe.setServerUrl,
    setHint: probe.setHint,
    setWorkspaces,
    pushNav,
  });

  /** Resume a remembered session or API key, or the offline workspace. */
  useEffect(() => {
    const rememberedUrl = readStored(STORAGE_KEYS.serverUrl);
    const rememberedWorkspace = readStored(STORAGE_KEYS.workspaceId);
    const rememberedSession = readStored(STORAGE_KEYS.sessionToken);
    const rememberedApiKey = readStored(STORAGE_KEYS.apiKey);
    const credential = rememberedSession !== "" ? rememberedSession : rememberedApiKey;
    const credentialType: CredentialType = rememberedSession !== "" ? "session" : "apikey";
    if (rememberedUrl !== "" && credential !== "") {
      // Validate the credential first: an expired session or revoked key must
      // land on the sign-in screen, not on an empty-looking local store with
      // a silent sync error.
      Promise.all([listWorkspaces(rememberedUrl, credential), fetchMe(rememberedUrl, credential)])
        .then(async ([{ workspaces: list }, me]) => {
          auth.setUser(me);
          if (window.location.pathname === "/workspaces" || rememberedWorkspace === "") {
            // Reload/deep link on the manager (or no workspace to resume
            // yet): land there instead of auto-connecting. connect would
            // rewrite the URL to "/" and boot the app shell.
            probe.setServerUrl(rememberedUrl);
            auth.setToken(credential);
            setSessionSignedIn(credentialType === "session");
            setWorkspaces(list);
            rememberWorkspaceList(list);
            setPhase({ name: "workspaces", user: me });
            return;
          }
          // Deep-link resolution: a /<node-uuid> URL names a node that may
          // live in another of the account's workspaces. Connect straight to
          // the holder instead of the remembered workspace.
          rememberWorkspaceList(list);
          const nodeMatch =
            /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
              window.location.pathname,
            );
          if (nodeMatch !== null) {
            try {
              const { workspaceId } = await fetchNodeLocation(
                rememberedUrl,
                credential,
                nodeMatch[1]!,
              );
              if (
                workspaceId !== rememberedWorkspace &&
                list.some((ws) => ws.id === workspaceId)
              ) {
                return connect(rememberedUrl, credential, workspaceId, {
                  isOffline: false,
                  credentialType,
                  label: list.find((ws) => ws.id === workspaceId)?.name ?? "Workspace",
                });
              }
            } catch {
              // Node unknown or lookup unreachable: the remembered workspace
              // opens and the node view renders its honest not-found state.
            }
          }
          return connect(rememberedUrl, credential, rememberedWorkspace, {
            isOffline: false,
            credentialType,
            label: list.find((ws) => ws.id === rememberedWorkspace)?.name ?? "Workspace",
          });
        })
        .catch((err: unknown) => {
          // Unreachable ≠ unauthorized. Only a rejected credential clears the
          // session (an expired session or revoked key must land on the
          // sign-in screen). A server that does not answer — network failure
          // or any non-401 response — keeps the credential and opens the
          // remembered workspace from its local copy instead: the worker
          // boots from local bytes even with the relay down, the sync-status
          // banner says "working locally until it recovers", and the
          // realtime reconnect catches up when the server returns.
          if (
            err instanceof AuthRequestError &&
            (err.status === 401 || err.status === 403)
          ) {
            clearStored(STORAGE_KEYS.sessionToken);
            clearStored(STORAGE_KEYS.apiKey);
            auth.setToken("");
            setPhase({ name: "server" });
            return;
          }
          if (rememberedWorkspace !== "") {
            return connect(rememberedUrl, credential, rememberedWorkspace, {
              isOffline: false,
              credentialType,
              label: rememberedWorkspaceName(rememberedWorkspace) ?? "Workspace",
            });
          }
          // No workspace to open locally (the manager was the last surface):
          // the server form, credential intact.
          setPhase({ name: "server" });
        });
      return;
    }
    // No credential: fall through to the server screen (offline users keep
    // their local workspace id for the workspaces/offline flows).
    setPhase({ name: "server" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** "Work offline": a device-local workspace, no account required. */
  async function handleWorkOffline() {
    let localId = readStored(STORAGE_KEYS.localWorkspaceId);
    if (localId === "") {
      // crypto.randomUUID is secure-context-gated — unavailable on the
      // plain-http LAN dev entry, where "Work offline" is a first-run path
      // (audit 2026-10-19: the throw silently broke offline connect there).
      // getRandomValues is NOT gated; build an RFC 4122 v4 id from it.
      const webCrypto: Crypto | undefined = globalThis.crypto;
      if (webCrypto !== undefined && typeof webCrypto.randomUUID === "function") {
        localId = webCrypto.randomUUID();
      } else if (webCrypto !== undefined) {
        const bytes = new Uint8Array(16);
        webCrypto.getRandomValues(bytes);
        bytes[6] = (bytes[6]! & 0x0f) | 0x40;
        bytes[8] = (bytes[8]! & 0x3f) | 0x80;
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
        localId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      } else {
        // No Web Crypto at all (ancient context): last-resort non-secure id.
        localId = `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      }
      writeStored(STORAGE_KEYS.localWorkspaceId, localId);
    }
    await connect(readStored(STORAGE_KEYS.serverUrl), "", localId, {
      isOffline: true,
      credentialType: "session",
      label: "This device (offline)",
    });
  }

  return {
    ...probe,
    ...auth,
    workspaces,
    handleWorkOffline,
  };
}
