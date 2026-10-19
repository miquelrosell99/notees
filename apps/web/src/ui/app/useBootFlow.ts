/**
 * useBootFlow — the boot/auth flow: server probe → setup/login/signup →
 * workspace manager entry, plus the remembered-session resume effect.
 *
 * Owns the boot-form state (server URL, credentials, auth tab, signup
 * flag, user/token/workspace list, hints + the same-host suggestion) and
 * every handler the boot form renders. The connection state and connect()
 * come from useWorkspaceConnection (passed in); the phase/error state it
 * drives lives there too. App consumes the hook and hands the flow to
 * BootForm; the shell reads the account state (user/token/serverUrl) from
 * the returned flow.
 */

import { useEffect, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";

import {
  AuthRequestError,
  createWorkspace,
  fetchMe,
  fetchNodeLocation,
  fetchServerInfo,
  listWorkspaces,
  login,
  setupAccount,
  signup,
  type AccountUser,
  type WorkspaceEntry,
} from "@/core/auth-api.js";
import { rememberWorkspaceList, rememberedWorkspaceName } from "@/core/workspace-registry.js";
import { STORAGE_KEYS, clearStored, initialServerUrl, readStored, sameHostServerUrl, writeStored } from "./storage.js";
import type { CredentialType } from "./store-connection.js";
import type { WorkspaceConnection } from "./useWorkspaceConnection.js";

export interface BootFlow {
  serverUrl: string;
  setServerUrl: Dispatch<SetStateAction<string>>;
  email: string;
  setEmail: Dispatch<SetStateAction<string>>;
  password: string;
  setPassword: Dispatch<SetStateAction<string>>;
  passwordConfirm: string;
  setPasswordConfirm: Dispatch<SetStateAction<string>>;
  displayName: string;
  setDisplayName: Dispatch<SetStateAction<string>>;
  authTab: "account" | "apikey";
  setAuthTab: Dispatch<SetStateAction<"account" | "apikey">>;
  /**
   * NOTEES_SIGNUP_ENABLED as reported by /server-info: the login screen's
   * "No account yet? Create one" affordance renders only when the server
   * advertises it (the route 404s regardless when the flag is off).
   */
  signupEnabled: boolean;
  apiKeyInput: string;
  setApiKeyInput: Dispatch<SetStateAction<string>>;
  user: AccountUser | null;
  setUser: Dispatch<SetStateAction<AccountUser | null>>;
  token: string;
  setToken: Dispatch<SetStateAction<string>>;
  workspaces: WorkspaceEntry[];
  newWorkspaceName: string;
  setNewWorkspaceName: Dispatch<SetStateAction<string>>;
  hint: string | null;
  setHint: Dispatch<SetStateAction<string | null>>;
  /**
   * Same-host guess offered under the boot form after a failed probe
   * (TypeError only). Clicking the suggestion button is the only path to the
   * guess — the boot screen never silently re-routes.
   */
  serverSuggestion: string | null;
  setServerSuggestion: Dispatch<SetStateAction<string | null>>;
  /** The settings Sync tab reuses the boot form's probe path. */
  connectTo: (rawUrl: string) => Promise<void>;
  handleServerSubmit: (event: FormEvent) => Promise<void>;
  handleServerSuggestion: () => Promise<void>;
  handleSetup: (event: FormEvent) => Promise<void>;
  handleLogin: (event: FormEvent) => Promise<void>;
  handleSignup: (event: FormEvent) => Promise<void>;
  handleApiKeySubmit: (event: FormEvent) => Promise<void>;
  handleCreateWorkspace: (event: FormEvent) => Promise<void>;
  handleWorkOffline: () => Promise<void>;
}

export function useBootFlow(
  conn: WorkspaceConnection,
  pushNav: (url: string, state: Record<string, unknown>) => void,
): BootFlow {
  const { connect, setPhase, setError, setSessionSignedIn } = conn;
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [user, setUser] = useState<AccountUser | null>(null);
  const [token, setToken] = useState(() => readStored(STORAGE_KEYS.sessionToken));
  const [authTab, setAuthTab] = useState<"account" | "apikey">("account");
  const [signupEnabled, setSignupEnabled] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [serverSuggestion, setServerSuggestion] = useState<string | null>(null);

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
          setUser(me);
          if (window.location.pathname === "/workspaces" || rememberedWorkspace === "") {
            // Reload/deep link on the manager (or no workspace to resume
            // yet): land there instead of auto-connecting. connect would
            // rewrite the URL to "/" and boot the app shell.
            setServerUrl(rememberedUrl);
            setToken(credential);
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
            setToken("");
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

  async function probeServer(url: string): Promise<void> {
    const info = await fetchServerInfo(url);
    setServerUrl(url);
    // Older servers predate the field — treat absent as closed.
    setSignupEnabled(info.signupEnabled === true);
    if (info.setupRequired) {
      setPhase({ name: "setup" });
    } else {
      setPhase({ name: "login" });
    }
  }

  /**
   * Probe `rawUrl` and advance to setup/login on success — the single
   * connect path for the boot form and the settings Sync tab (identical
   * behavior everywhere). On failure the error + hint surface under the boot
   * form; a failed fetch (TypeError — unreachable host, connection refused,
   * CORS preflight block) additionally offers the same-host guess as an
   * explicit suggestion.
   */
  async function connectTo(rawUrl: string): Promise<void> {
    setError(null);
    setHint(null);
    setServerSuggestion(null);
    const url = rawUrl.trim().replace(/\/$/, "");
    try {
      await probeServer(url);
      return;
    } catch (err) {
      // Whatever the cause, the single most common fix on first connect is
      // the same-host guess (hand-typed "localhost" points at the user's own
      // device) — offered, never taken automatically.
      const guess = sameHostServerUrl();
      if (err instanceof TypeError && guess !== "" && guess !== url) {
        setServerSuggestion(guess);
      }
      setError(err instanceof Error ? err.message : String(err));
      // Browsers block plain-http fetches from an https page as mixed
      // content — the failure surfaces as a bare NetworkError, so name the
      // law when it applies (the sync API must be same-origin https here,
      // or the page itself reached over http).
      const mixedContent =
        typeof location !== "undefined" &&
        location.protocol === "https:" &&
        url.startsWith("http://");
      setHint(
        mixedContent
          ? "This page is https, and browsers block http API calls from it " +
            "(mixed content) before they leave the device. Use the page " +
            "origin (the suggested address), or reach the web UI over http " +
            "to use a plain-http sync address."
          : "Could not reach a sync server at that address. Check that the URL " +
            "points at the machine running the sync server — not this device — " +
            "and that the port is reachable (a firewall or a reverse proxy can " +
            "also block it).",
      );
    }
  }

  async function handleServerSubmit(event: FormEvent) {
    event.preventDefault();
    await connectTo(serverUrl);
  }

  /** The suggestion button is the ONLY path to the guess: an explicit click. */
  async function handleServerSuggestion() {
    if (serverSuggestion === null) return;
    const guess = serverSuggestion;
    setServerUrl(guess);
    setServerSuggestion(null);
    await connectTo(guess);
  }

  async function enterWorkspaces(url: string, sessionToken: string, account: AccountUser) {
    setUser(account);
    setToken(sessionToken);
    // Persist the session NOW (not only after connect): a reload while the
    // manager is open must resume back onto it instead of the server form.
    writeStored(STORAGE_KEYS.serverUrl, url);
    writeStored(STORAGE_KEYS.sessionToken, sessionToken);
    clearStored(STORAGE_KEYS.apiKey);
    setSessionSignedIn(true);
    setPhase({ name: "connecting", label: "Loading workspaces…" });
    try {
      const { workspaces: list } = await listWorkspaces(url, sessionToken);
      setWorkspaces(list);
      rememberWorkspaceList(list);
      pushNav("/workspaces", { view: "workspaces" });
      setPhase({ name: "workspaces", user: account });
    } catch (err) {
      setPhase({ name: "server" });
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSetup(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== passwordConfirm) {
      setError("Passwords do not match.");
      return;
    }
    try {
      const response = await setupAccount(serverUrl, {
        email: email.trim(),
        password,
        displayName: displayName.trim() || undefined,
      });
      await enterWorkspaces(serverUrl, response.token, response.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const response = await login(serverUrl, { email: email.trim(), password });
      await enterWorkspaces(serverUrl, response.token, response.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSignup(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== passwordConfirm) {
      setError("Passwords do not match.");
      return;
    }
    try {
      const response = await signup(serverUrl, { email: email.trim(), password });
      await enterWorkspaces(serverUrl, response.token, response.user);
    } catch (err) {
      // A 404 here means the server closed signups after the client probed it
      // — say so instead of showing the server's bare "not found".
      const message = err instanceof Error ? err.message : String(err);
      setError(message.toLowerCase() === "not found" ? "Signups are disabled on this server." : message);
    }
  }

  async function handleApiKeySubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setHint(null);
    let url = serverUrl.trim().replace(/\/$/, "");
    const key = apiKeyInput.trim();
    if (key === "") {
      setError("Enter an API key.");
      return;
    }
    try {
      // Validating against /workspaces also proves the key: a user API key
      // authenticates as its owner (routes-auth requireUser). No silent
      // same-host fallback (never re-route without an
      // explicit user action) — a NetworkError surfaces with the suggestion
      // path, same as the account flow.
      const list = (await listWorkspaces(url, key)).workspaces;
      setServerUrl(url);
      setToken(key);
      // Persist the key NOW (not only after connect): a reload while the
      // manager is open must resume back onto it instead of the server form.
      writeStored(STORAGE_KEYS.serverUrl, url);
      writeStored(STORAGE_KEYS.apiKey, key);
      clearStored(STORAGE_KEYS.sessionToken);
      setWorkspaces(list);
      setPhase({ name: "workspaces", user: { id: "", email: "API key", displayName: null, name: null, surnames: null, avatarUrl: null, isAdmin: false } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCreateWorkspace(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const { id } = await createWorkspace(serverUrl, token, newWorkspaceName.trim() || undefined);
      setNewWorkspaceName("");
      await connect(serverUrl, token, id, {
        isOffline: false,
        credentialType: authTab === "apikey" ? "apikey" : "session",
        label: newWorkspaceName.trim() || "Workspace",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

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
    serverUrl,
    setServerUrl,
    email,
    setEmail,
    password,
    setPassword,
    passwordConfirm,
    setPasswordConfirm,
    displayName,
    setDisplayName,
    authTab,
    setAuthTab,
    signupEnabled,
    apiKeyInput,
    setApiKeyInput,
    user,
    setUser,
    token,
    setToken,
    workspaces,
    newWorkspaceName,
    setNewWorkspaceName,
    hint,
    setHint,
    serverSuggestion,
    setServerSuggestion,
    connectTo,
    handleServerSubmit,
    handleServerSuggestion,
    handleSetup,
    handleLogin,
    handleSignup,
    handleApiKeySubmit,
    handleCreateWorkspace,
    handleWorkOffline,
  };
}
