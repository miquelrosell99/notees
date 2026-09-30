/**
 * App — boot flow + shell.
 *
 * Boot flow (offline-first, account-based):
 *  1. "server"     — enter the sync server URL (prefilled by /config.js or
 *                    remembered); the client fetches /server-info and picks:
 *  2. "setup"      — no users on the server yet → create the admin account;
 *  3. "login"      — email + password → session token;
 *  4. "workspaces" — pick a workspace, create one, or adopt "this device's"
 *                    offline workspace (its unpushed backlog pushes on
 *                    connect — the durable local op log);
 *  5. "ready"      — the outliner shell over a WorkerClient (OPFS-persisted
 *                    store). "Work offline" skips 1–4 entirely: a local
 *                    workspace with no server, sync pending until a later
 *                    login adopts it.
 *
 * The session token travels in the credential slot the relay API key used
 * to occupy (X-API-Key / Bearer); the operator API key keeps working for
 * the CLI. After connect the WS acceleration path is wired (startRealtime)
 * and the footer polls the worker's sync status.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";

import { deriveDisplayName, SYSTEM_CLASS_UUIDS } from "@notees/domain";
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";

import { WorkspaceClient, type SyncStatusSnapshot } from "@/core/workspace-client.js";
import { WorkerClient } from "@/core/worker-client.js";
import {
  createWorkspace,
  fetchServerInfo,
  listWorkspaces,
  login,
  logout,
  setupAccount,
  type AccountUser,
  type WorkspaceEntry,
} from "@/core/auth-api.js";

import { PageView } from "./PageView.js";
import { ClassView } from "./ClassView.js";
import { SearchBox } from "./SearchBox.js";
import { SettingsPanel } from "./SettingsPanel.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { Icon } from "./Icon.js";
import "./app.css";

const STORAGE_KEYS = {
  serverUrl: "notees.serverUrl",
  sessionToken: "notees.sessionToken",
  apiKey: "notees.apiKey",
  workspaceId: "notees.workspaceId",
  /** Device-local workspace created by "Work offline". */
  localWorkspaceId: "notees.localWorkspaceId",
} as const;

type CredentialType = "session" | "apikey";

/** Footer status before the first status() snapshot arrives. */
const INITIAL_SYNC_STATUS: SyncStatusSnapshot = {
  status: "idle",
  error: null,
  pending: 0,
  failed: 0,
  quarantined: 0,
  parked: 0,
  realtime: false,
  cursorSeq: 0,
};

/** Poll cadence for the sync status snapshot while mounted. */
const STATUS_POLL_MS = 2_000;

type StoreMode = "worker" | "in-process";
type AnyClient = WorkspaceClient | WorkerClient;

type Phase =
  | { name: "server" }
  | { name: "setup" }
  | { name: "login" }
  | { name: "workspaces"; user: AccountUser }
  | { name: "connecting"; label: string }
  | { name: "ready" };

function detectStoreMode(): StoreMode {
  return typeof Worker !== "undefined" &&
    typeof navigator !== "undefined" &&
    navigator.storage?.getDirectory !== undefined
    ? "worker"
    : "in-process";
}

function readStored(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode); the session just won't persist.
  }
}

function clearStored(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore.
  }
}

/** Footer sync line: engine state, undelivered backlog, realtime indicator. */
function SyncStatusLine({ snapshot }: { snapshot: SyncStatusSnapshot }) {
  const backlog = snapshot.pending + snapshot.failed;
  const label =
    snapshot.status === "idle"
      ? `Sync: idle · ${backlog} pending`
      : snapshot.status === "syncing"
        ? `Sync: syncing… · ${backlog} pending`
        : `Sync error${snapshot.error ? `: ${snapshot.error}` : ""} · ${backlog} pending`;
  return (
    <span
      className={
        snapshot.status === "error" ? "nt-sync-status nt-sync-status-error" : "nt-sync-status"
      }
      title={snapshot.error ?? undefined}
    >
      {label}
      {snapshot.realtime ? "" : " · realtime off"}
    </span>
  );
}

/**
 * Initial server URL: a remembered value (localStorage) wins; then the
 * /config.js runtime prefill (window.NOTEES_CONFIG); then a same-host guess —
 * a sync server colocated with the web client conventionally listens on
 * :8377, and `localhost` would point at the user's own device, not the host
 * serving this page (the classic "NetworkError" trap on first connect).
 */
function initialServerUrl(): string {
  const remembered = readStored(STORAGE_KEYS.serverUrl);
  if (remembered !== "") return remembered;
  // Same-host guess wins over the baked /config.js default: config.js is a
  // deploy-time value that may not match how this browser actually reaches
  // the host, while the guess derives from the page origin itself.
  const guess = sameHostServerUrl();
  if (guess !== "") return guess;
  return window.NOTEES_CONFIG?.serverUrl || "";
}

/**
 * Best guess for a colocated sync server: same host as this page, port 8377.
 * `localhost` entered by hand points at the user's own device, which is the
 * classic first-connect failure — this guess is what the auto-retry falls
 * back to.
 */
function sameHostServerUrl(): string {
  if (typeof location !== "undefined" && location.hostname !== "") {
    return `${location.protocol}//${location.hostname}:8377`;
  }
  return "";
}

/**
 * View resolution = f(node_type) (SCHEMA.md): a class node renders the Class
 * View, everything else the Page View. Exported for the view-routing tests.
 */
export function NodeView({
  client,
  nodeId,
  onOpenNode,
}: {
  client: WorkspaceClient | WorkerClient;
  nodeId: string;
  onOpenNode?: ((nodeId: string) => void) | undefined;
}) {
  const node = client.getNode(nodeId);
  if (node === undefined) {
    return <div className="nt-page-missing">Page not found.</div>;
  }
  if (node.nodeType === "class") {
    return (
      <ClassView client={client} classId={nodeId} onOpenClass={onOpenNode} onOpenPage={onOpenNode} />
    );
  }
  return <PageView client={client} pageId={nodeId} onOpenPage={onOpenNode} />;
}

export function App() {
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [phase, setPhase] = useState<Phase>({ name: "server" });
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  /** Set when the auto-retry swapped the server URL, so the next screen explains it. */
  const [bootNote, setBootNote] = useState<string | null>(null);
  const [user, setUser] = useState<AccountUser | null>(null);
  const [token, setToken] = useState(() => readStored(STORAGE_KEYS.sessionToken));
  const [authTab, setAuthTab] = useState<"account" | "apikey">("account");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** True when the live credential is a session (API-key management needs one). */
  const [sessionSignedIn, setSessionSignedIn] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [workspaceName, setWorkspaceName] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [navFilter, setNavFilter] = useState<"journal" | "inbox" | "pages" | "whiteboards" | "tasks">("pages");
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      return JSON.parse(readStored("notees.favorites") || "[]") as string[];
    } catch {
      return [];
    }
  });
  const [recents, setRecents] = useState<string[]>(() => {
    try {
      return JSON.parse(readStored("notees.recents") || "[]") as string[];
    } catch {
      return [];
    }
  });

  /** Open a node and record it in Recents (local UI state, device-only). */
  function openPage(id: string): void {
    setSelectedPageId(id);
    setRecents((previous) => {
      const next = [id, ...previous.filter((entry) => entry !== id)].slice(0, 8);
      writeStored("notees.recents", JSON.stringify(next));
      return next;
    });
  }

  function toggleFavorite(id: string): void {
    setFavorites((previous) => {
      const next = previous.includes(id) ? previous.filter((entry) => entry !== id) : [...previous, id];
      writeStored("notees.favorites", JSON.stringify(next));
      return next;
    });
  }
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [client, setClient] = useState<AnyClient | null>(null);
  const [offline, setOffline] = useState(false);
  const [storeMode, setStoreMode] = useState<StoreMode>("in-process");
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatusSnapshot>(INITIAL_SYNC_STATUS);
  const [pagesVersion, setPagesVersion] = useState(0);

  /**
   * The single owner of the live client for teardown. State (`client`) drives
   * rendering; the ref lets the unmount-only effect below close exactly the
   * client that is live at unmount time.
   */
  const clientRef = useRef<AnyClient | null>(null);
  const serverUrlRef = useRef(serverUrl);
  serverUrlRef.current = serverUrl;

  useEffect(() => {
    if (client === null) return;
    return client.subscribe(() => setPagesVersion((v) => v + 1));
  }, [client]);

  // Poll the (cheap) status snapshot on a cadence and on every worker
  // notification; both fire React state only when the client changes.
  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const snapshot = await client.status();
        if (!cancelled) setSyncStatus(snapshot);
      } catch {
        // Client closed mid-poll; the effect teardown disposes the interval.
      }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), STATUS_POLL_MS);
    const unsubscribe = client.subscribe(() => void refresh());
    return () => {
      cancelled = true;
      clearInterval(interval);
      unsubscribe();
    };
  }, [client]);

  // StrictMode-safe teardown: empty-deps cleanup runs on real unmount only,
  // and the identity check guarantees a dev double-invoked cleanup (or a
  // connect-swap below) never closes a client something else still owns.
  useEffect(() => {
    return () => {
      const live = clientRef.current;
      clientRef.current = null;
      live?.close();
    };
  }, []);

  /**
   * Boot a client for `workspaceId`. `credential` is the session token (or
   * operator API key); `isOffline` builds an OfflineTransport instead. The
   * worker store is keyed by workspace id, so adopting "this device's"
   * offline workspace later reuses the same OPFS file and its unpushed
   * backlog drains through the normal outbox push.
   */
  async function connect(
    url: string,
    credential: string,
    workspaceId: string,
    options: { isOffline: boolean; credentialType: CredentialType; label?: string },
  ): Promise<void> {
    setPhase({ name: "connecting", label: options.isOffline ? "Opening local workspace…" : "Connecting…" });
    setError(null);
    const previous = clientRef.current;
    clientRef.current = null;
    previous?.close();
    setClient(null);
    try {
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
        // The worker path bootstraps during init; the in-process path syncs here.
        await nextClient.bootstrapWorkspace(workspaceId);
      }
      if (options.credentialType === "session") {
        writeStored(STORAGE_KEYS.sessionToken, credential);
        clearStored(STORAGE_KEYS.apiKey);
        setSessionSignedIn(true);
      } else if (options.credentialType === "apikey") {
        writeStored(STORAGE_KEYS.apiKey, credential);
        clearStored(STORAGE_KEYS.sessionToken);
        setSessionSignedIn(false);
      }
      setWorkspaceName(options.label ?? "Workspace");
      clientRef.current = nextClient;
      setClient(nextClient);
      setOffline(options.isOffline);
      setStoreMode(mode);
      setPhase({ name: "ready" });
      // Realtime acceleration is best-effort: sync already works without it.
      try {
        await nextClient.startRealtime();
      } catch {
        // No WS available/reachable — HTTP catch-up keeps working.
      }
    } catch (err) {
      setPhase({ name: "server" });
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Resume a remembered session or API key, or the offline workspace. */
  useEffect(() => {
    const rememberedUrl = readStored(STORAGE_KEYS.serverUrl);
    const rememberedWorkspace = readStored(STORAGE_KEYS.workspaceId);
    const rememberedSession = readStored(STORAGE_KEYS.sessionToken);
    const rememberedApiKey = readStored(STORAGE_KEYS.apiKey);
    const credential = rememberedSession !== "" ? rememberedSession : rememberedApiKey;
    const credentialType: CredentialType = rememberedSession !== "" ? "session" : "apikey";
    if (rememberedUrl !== "" && credential !== "" && rememberedWorkspace !== "") {
      // Validate the credential first: an expired session or revoked key must
      // land on the sign-in screen, not on an empty-looking local store with
      // a silent sync error.
      listWorkspaces(rememberedUrl, credential)
        .then(({ workspaces: list }) => {
          setWorkspaceName(list.find((ws) => ws.id === rememberedWorkspace)?.name ?? "Workspace");
          return connect(rememberedUrl, credential, rememberedWorkspace, {
            isOffline: false,
            credentialType,
          });
        })
        .catch(() => {
          clearStored(STORAGE_KEYS.sessionToken);
          clearStored(STORAGE_KEYS.apiKey);
          setToken("");
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
    if (info.setupRequired) {
      setPhase({ name: "setup" });
    } else {
      setPhase({ name: "login" });
    }
  }

  async function handleServerSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setHint(null);
    setBootNote(null);
    const url = serverUrl.trim().replace(/\/$/, "");
    try {
      await probeServer(url);
      return;
    } catch (err) {
      // A failed fetch surfaces as TypeError("NetworkError…"/"Failed to
      // fetch") with no status: unreachable host, connection refused, or a
      // CORS preflight block. Whatever the cause, the single most common fix
      // on first connect is the same-host guess (hand-typed "localhost"
      // points at the user's own device) — so try it once, automatically.
      const guess = sameHostServerUrl();
      if (err instanceof TypeError && guess !== "" && guess !== url) {
        try {
          await probeServer(guess);
          setBootNote(
            `"${url}" did not respond — using ${guess} instead. You can change it by going back.`,
          );
          return;
        } catch {
          // Both failed: fall through to the generic message below.
        }
      }
      setError(err instanceof Error ? err.message : String(err));
      setHint(
        "Could not reach a sync server at that address. Check that the URL " +
          "points at the machine running the sync server — not this device — " +
          "and that the port is reachable (a firewall or a reverse proxy can " +
          "also block it).",
      );
    }
  }

  async function enterWorkspaces(url: string, sessionToken: string, account: AccountUser) {
    setUser(account);
    setToken(sessionToken);
    setPhase({ name: "connecting", label: "Loading workspaces…" });
    try {
      const { workspaces: list } = await listWorkspaces(url, sessionToken);
      setWorkspaces(list);
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
      // authenticates as its owner (routes-auth requireUser). NetworkError →
      // same one-shot same-host fallback as the account flow.
      let list: WorkspaceEntry[];
      try {
        list = (await listWorkspaces(url, key)).workspaces;
      } catch (err) {
        const guess = sameHostServerUrl();
        if (err instanceof TypeError && guess !== "" && guess !== url) {
          url = guess;
          list = (await listWorkspaces(url, key)).workspaces;
        } else {
          throw err;
        }
      }
      setServerUrl(url);
      setToken(key);
      setWorkspaces(list);
      setPhase({ name: "workspaces", user: { id: "", email: "API key", displayName: null, isAdmin: false } });
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
      localId = crypto.randomUUID();
      writeStored(STORAGE_KEYS.localWorkspaceId, localId);
    }
    await connect(readStored(STORAGE_KEYS.serverUrl), "", localId, {
      isOffline: true,
      credentialType: "session",
      label: "This device (offline)",
    });
  }

  async function handleSignOut() {
    const url = readStored(STORAGE_KEYS.serverUrl);
    const sessionToken = readStored(STORAGE_KEYS.sessionToken);
    if (url !== "" && sessionToken !== "") {
      try {
        await logout(url, sessionToken);
      } catch {
        // Best-effort: the local credential is cleared regardless.
      }
    }
    clearStored(STORAGE_KEYS.sessionToken);
    clearStored(STORAGE_KEYS.apiKey);
    setToken("");
    setUser(null);
    setSettingsOpen(false);
    const live = clientRef.current;
    clientRef.current = null;
    live?.close();
    setClient(null);
    setPhase({ name: "server" });
  }

  async function handleNewPage() {
    if (client === null) return;
    const id = await client.createObject({ nodeType: "page", name: "Untitled" });
    setSelectedPageId(id);
  }

  const localWorkspaceId = readStored(STORAGE_KEYS.localWorkspaceId);
  const showDeviceWorkspace =
    phase.name === "workspaces" &&
    localWorkspaceId !== "" &&
    !workspaces.some((ws) => ws.id === localWorkspaceId);

  if (phase.name === "server" || phase.name === "setup" || phase.name === "login") {
    const isLogin = phase.name === "login";
    return (
      <div className="nt-bootstrap">
        <div className="nt-bootstrap-form nt-card">
          <div className="nt-brand">
            <span className="nt-brand-mark" aria-hidden="true">
              ◈
            </span>
            <h1 className="nt-bootstrap-title">Notees</h1>
          </div>
          {phase.name === "server" && (
            <p className="nt-bootstrap-subtitle">Connect to your sync server — or work offline.</p>
          )}
          {phase.name === "setup" && (
            <p className="nt-bootstrap-subtitle">Initial setup — create the admin account</p>
          )}
          {phase.name !== "server" && bootNote !== null && (
            <p className="nt-hint">{bootNote}</p>
          )}
          {isLogin && (
            <div className="nt-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={authTab === "account"}
                className={authTab === "account" ? "nt-tab nt-tab-active" : "nt-tab"}
                onClick={() => {
                  setAuthTab("account");
                  setError(null);
                }}
              >
                Account
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={authTab === "apikey"}
                className={authTab === "apikey" ? "nt-tab nt-tab-active" : "nt-tab"}
                onClick={() => {
                  setAuthTab("apikey");
                  setError(null);
                }}
              >
                API key
              </button>
            </div>
          )}

          {isLogin && authTab === "apikey" ? (
            <form
              className="nt-form"
              onSubmit={(e) => void handleApiKeySubmit(e)}
            >
              <label className="nt-field">
                <span>Server URL</span>
                <input
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder="https://notees.example.com"
                  required
                />
              </label>
              <label className="nt-field">
                <span>API key</span>
                <input
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder="nk_…"
                  autoComplete="off"
                  required
                />
              </label>
              <button type="submit" className="nt-btn nt-btn-primary">
                Sign in with key
              </button>
              <button
                type="button"
                className="nt-btn nt-btn-secondary"
                onClick={() => {
                  setApiKeyInput("");
                  setError(null);
                  setBootNote(null);
                  setPhase({ name: "server" });
                }}
              >
                Change server
              </button>
              {hint !== null && <p className="nt-hint">{hint}</p>}
              {error !== null && <p className="nt-error">{error}</p>}
            </form>
          ) : (
            <form
              className="nt-form"
              onSubmit={(e) =>
                void (phase.name === "setup"
                  ? handleSetup(e)
                  : isLogin
                    ? handleLogin(e)
                    : handleServerSubmit(e))
              }
            >
              <label className="nt-field">
                <span>Server URL</span>
                <input
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder="https://notees.example.com"
                  disabled={phase.name !== "server"}
                  required
                />
              </label>
              {phase.name === "setup" && (
                <label className="nt-field">
                  <span>Name (optional)</span>
                  <input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    autoComplete="name"
                  />
                </label>
              )}
              {phase.name !== "server" && (
                <>
                  <label className="nt-field">
                    <span>Email</span>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      autoComplete="email"
                      required
                    />
                  </label>
                  <label className="nt-field">
                    <span>Password</span>
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete={phase.name === "setup" ? "new-password" : "current-password"}
                      required
                    />
                  </label>
                </>
              )}
              {phase.name === "setup" && (
                <label className="nt-field">
                  <span>Confirm password</span>
                  <input
                    type="password"
                    value={passwordConfirm}
                    onChange={(e) => setPasswordConfirm(e.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </label>
              )}
              <button type="submit" className="nt-btn nt-btn-primary">
                {phase.name === "setup" ? "Create account" : isLogin ? "Sign in" : "Continue"}
              </button>
              {phase.name === "server" && (
                <button
                  type="button"
                  className="nt-btn nt-btn-secondary"
                  onClick={() => void handleWorkOffline()}
                >
                  Work offline
                </button>
              )}
              {isLogin && (
                <button
                  type="button"
                  className="nt-btn nt-btn-secondary"
                  onClick={() => {
                    setEmail("");
                    setPassword("");
                    setError(null);
                    setBootNote(null);
                    setPhase({ name: "server" });
                  }}
                >
                  Change server
                </button>
              )}
              {hint !== null && <p className="nt-hint">{hint}</p>}
              {error !== null && <p className="nt-error">{error}</p>}
            </form>
          )}
          <div className="nt-bootstrap-footer">
            <ThemeToggle />
          </div>
        </div>
      </div>
    );
  }

  if (phase.name === "workspaces") {
    const credentialType: CredentialType = authTab === "apikey" ? "apikey" : "session";
    return (
      <div className="nt-bootstrap">
        <div className="nt-bootstrap-form nt-card nt-workspaces">
          <div className="nt-brand">
            <span className="nt-brand-mark" aria-hidden="true">
              ◈
            </span>
            <h1 className="nt-bootstrap-title">Notees</h1>
          </div>
          <p className="nt-bootstrap-subtitle">
            Signed in as {user?.email}. Choose a workspace:
          </p>
          <ul className="nt-workspace-list">
            {workspaces.map((ws) => (
              <li key={ws.id}>
                <button
                  type="button"
                  className="nt-workspace-item"
                  onClick={() =>
                    void connect(serverUrl, token, ws.id, {
                      isOffline: false,
                      credentialType,
                      label: ws.name ?? "Workspace",
                    })
                  }
                >
                  <span className="nt-workspace-name">{ws.name ?? "Workspace"}</span>
                  <span className="nt-workspace-meta">
                    {ws.envelopeCount} ops · {ws.role}
                  </span>
                </button>
              </li>
            ))}
            {showDeviceWorkspace && (
              <li>
                <button
                  type="button"
                  className="nt-workspace-item nt-workspace-device"
                  onClick={() =>
                    void connect(serverUrl, token, localWorkspaceId, {
                      isOffline: false,
                      credentialType,
                      label: "This device",
                    })
                  }
                >
                  <span className="nt-workspace-name">This device</span>
                  <span className="nt-workspace-meta">offline workspace — pushes on connect</span>
                </button>
              </li>
            )}
          </ul>
          <form className="nt-workspace-new" onSubmit={(e) => void handleCreateWorkspace(e)}>
            <input
              value={newWorkspaceName}
              onChange={(e) => setNewWorkspaceName(e.target.value)}
              placeholder="New workspace name"
            />
            <button type="submit">Create</button>
          </form>
          <div className="nt-bootstrap-actions">
            <button type="button" className="nt-bootstrap-secondary" onClick={() => void handleWorkOffline()}>
              Work offline
            </button>
            <button type="button" className="nt-bootstrap-secondary" onClick={() => void handleSignOut()}>
              Sign out
            </button>
            <ThemeToggle />
          </div>
          {error !== null && <p className="nt-error">{error}</p>}
        </div>
      </div>
    );
  }

  if (phase.name === "connecting" || client === null) {
    return (
      <div className="nt-bootstrap">
        <div className="nt-bootstrap-form">
          <h1 className="nt-bootstrap-title">Notees</h1>
          <p className="nt-bootstrap-subtitle">
            {phase.name === "connecting" ? phase.label : "Starting…"}
          </p>
          {error !== null && <p className="nt-error">{error}</p>}
        </div>
      </div>
    );
  }

  // Asset-class nodes (uploaded files linked via the attachments property)
  // are library objects, not pages — keep them out of the page sidebar.
  const classes = client.listClasses();
  const assetClassId =
    classes.find((cls) => cls.name === "asset")?.id ?? SYSTEM_CLASS_UUIDS.asset;
  const pages = client.listPages().filter((page) => !page.classIds.includes(assetClassId));
  const dateClassIds: string[] = [
    SYSTEM_CLASS_UUIDS.day,
    SYSTEM_CLASS_UUIDS.month,
    SYSTEM_CLASS_UUIDS.year,
  ];
  const journalPages = pages.filter((page) => page.classIds.some((c) => dateClassIds.includes(c)));
  const whiteboardPages = pages.filter((page) => page.classIds.includes(SYSTEM_CLASS_UUIDS.whiteboard));
  const taskPages = pages.filter((page) => page.classIds.includes(SYSTEM_CLASS_UUIDS.task));
  const sectionIds = new Set([...journalPages, ...whiteboardPages, ...taskPages].map((p) => p.id));
  const inboxPages = pages.filter((page) => !sectionIds.has(page.id) && page.classIds.length === 0);
  const browsePages = pages.filter((page) => !sectionIds.has(page.id) && page.classIds.length > 0);
  const favoritePages = favorites
    .map((id) => pages.find((page) => page.id === id))
    .filter((page): page is (typeof pages)[number] => page !== undefined);
  const recentPages = recents
    .map((id) => pages.find((page) => page.id === id))
    .filter((page): page is (typeof pages)[number] => page !== undefined)
    .slice(0, 8);

  const renderRow = (node: (typeof pages)[number], icon?: string | null) => (
    <li key={node.id} className="nt-side-row">
      <button
        type="button"
        className={
          node.id === selectedPageId ? "nt-side-item nt-side-item-active" : "nt-side-item"
        }
        onClick={() => openPage(node.id)}
      >
        {icon !== null && icon !== undefined && (
          <Icon path={icon} size={1} className="nt-side-item-icon" />
        )}
        <span className="nt-side-item-label">{deriveDisplayName(node) || node.id}</span>
      </button>
      <button
        type="button"
        className="nt-side-star"
        title={favorites.includes(node.id) ? "Remove from favorites" : "Add to favorites"}
        onClick={() => toggleFavorite(node.id)}
      >
        <Icon path={favorites.includes(node.id) ? "mdi-star" : "mdi-star-outline"} size={0.9} />
      </button>
    </li>
  );

  const renderSection = (title: string, rows: ReturnType<typeof renderRow>[]) =>
    rows.length === 0 ? null : (
      <section className="nt-side-section">
        <h3 className="nt-side-header">{title}</h3>
        <ul className="nt-side-list">{rows}</ul>
      </section>
    );

  return (
    <div className={sidebarOpen ? "nt-app nt-sidebar-open" : "nt-app"}>
      <header className="nt-topbar">
        <button
          type="button"
          className="nt-icon-btn"
          aria-label="Toggle sidebar"
          onClick={() => setSidebarOpen((open) => !open)}
        >
          <Icon path="mdi-menu" size={1} />
        </button>
        <span className="nt-wordmark">Notees</span>
        <span className="nt-status-dot" aria-hidden="true" />
        <button
          type="button"
          className="nt-icon-btn"
          title="New page"
          aria-label="New page"
          onClick={() => void handleNewPage()}
        >
          <Icon path="mdi-plus" size={1} />
        </button>
        <span className="nt-topbar-spacer" />
        <SyncStatusLine snapshot={syncStatus} />
        <ThemeToggle />
        {sessionSignedIn && user !== null && !offline && (
          <button
            type="button"
            className="nt-icon-btn"
            title="Settings"
            aria-label="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <Icon path="mdi-cog-outline" size={1} />
          </button>
        )}
        <button
          type="button"
          className="nt-icon-btn"
          title="Sign out"
          aria-label="Sign out"
          onClick={() => void handleSignOut()}
        >
          <Icon path="mdi-logout-variant" size={1} />
        </button>
      </header>
      <div className="nt-body">
        <aside className="nt-sidebar">
          <div className="nt-sidebar-top">
            <button
              type="button"
              className="nt-ws-switch"
              title="Switch workspace (sign out)"
              onClick={() => void handleSignOut()}
            >
              <span className="nt-ws-name">{(workspaceName || "Workspace").toUpperCase()}</span>
              <Icon path="mdi-chevron-down" size={0.9} />
            </button>
            <button
              type="button"
              className="nt-icon-btn"
              title="Search"
              aria-label="Search"
              onClick={() => document.querySelector<HTMLInputElement>(".nt-searchbox input")?.focus()}
            >
              <Icon path="mdi-magnify" size={1} />
            </button>
          </div>
          <div className="nt-sidebar-search">
            <SearchBox client={client} onOpenNode={openPage} cacheVersion={pagesVersion} />
          </div>
          <nav className="nt-sidebar-nav">
            {renderSection(
              "Navigation",
              [
                <li key="journal" className="nt-side-row">
                  <button type="button" className="nt-side-item" onClick={() => setNavFilter("journal")}>
                    <Icon path="mdi-calendar-clock" size={1} className="nt-side-item-icon" />
                    <span className="nt-side-item-label">Journal</span>
                  </button>
                </li>,
                <li key="inbox" className="nt-side-row">
                  <button type="button" className="nt-side-item" onClick={() => setNavFilter("inbox")}>
                    <Icon path="mdi-tray-arrow-down" size={1} className="nt-side-item-icon" />
                    <span className="nt-side-item-label">Inbox</span>
                  </button>
                </li>,
                <li key="pages" className="nt-side-row">
                  <button type="button" className="nt-side-item" onClick={() => setNavFilter("pages")}>
                    <Icon path="mdi-book-open-page-variant" size={1} className="nt-side-item-icon" />
                    <span className="nt-side-item-label">Pages</span>
                  </button>
                </li>,
                <li key="whiteboards" className="nt-side-row">
                  <button type="button" className="nt-side-item" onClick={() => setNavFilter("whiteboards")}>
                    <Icon path="mdi-presentation" size={1} className="nt-side-item-icon" />
                    <span className="nt-side-item-label">Whiteboards</span>
                  </button>
                </li>,
                <li key="tasks" className="nt-side-row">
                  <button type="button" className="nt-side-item" onClick={() => setNavFilter("tasks")}>
                    <Icon path="mdi-format-list-checks" size={1} className="nt-side-item-icon" />
                    <span className="nt-side-item-label">Tasks</span>
                  </button>
                </li>,
              ],
            )}
            {renderSection("Favorites", favoritePages.map((page) => renderRow(page)))}
            {renderSection("Recents", recentPages.map((page) => renderRow(page)))}
            {renderSection(
              navFilter === "journal"
                ? "Journal"
                : navFilter === "inbox"
                  ? "Inbox"
                  : navFilter === "whiteboards"
                    ? "Whiteboards"
                    : navFilter === "tasks"
                      ? "Tasks"
                      : navFilter === "pages"
                        ? "Pages"
                        : "Pages",
              (
                navFilter === "journal"
                  ? journalPages
                  : navFilter === "inbox"
                    ? inboxPages
                    : navFilter === "whiteboards"
                      ? whiteboardPages
                      : navFilter === "tasks"
                        ? taskPages
                        : navFilter === "pages"
                          ? browsePages
                          : pages
              ).map((page) =>
                renderRow(
                  page,
                  classes.find((cls) => page.classIds.includes(cls.id))?.icon ?? null,
                ),
              ),
            )}
            {classes.length > 0 &&
              renderSection(
                "Classes",
                classes.map((cls) => renderRow(cls, cls.icon)),
              )}
          </nav>
          <div className="nt-sidebar-footer">
            <span className="nt-sidebar-user">{user?.email ?? "Offline"}</span>
            <span className="nt-sidebar-store">
              {offline
                ? "local workspace"
                : storeMode === "worker"
                  ? "Worker + OPFS"
                  : "in-process store"}
            </span>
          </div>
        </aside>
        <main className="nt-main">
          {selectedPageId !== null ? (
            <NodeView client={client} nodeId={selectedPageId} onOpenNode={openPage} />
          ) : (
            <div className="nt-empty">Select a page.</div>
          )}
        </main>
      </div>
      {settingsOpen && sessionSignedIn && user !== null && !offline && (
        <SettingsPanel
          serverUrl={serverUrl}
          token={token}
          user={user}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}