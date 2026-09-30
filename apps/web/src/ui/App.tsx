/**
 * App — boot flow + shell composition.
 *
 * Boot flow (offline-first, account-based):
 *  1. "server"     — enter the sync server URL (prefilled by /config.js or
 *                    remembered); the client fetches /server-info and picks:
 *  2. "setup"      — no users on the server yet → create the admin account;
 *  3. "login"      — email + password → session token;
 *  4. "workspaces" — pick a workspace, create one, or adopt "this device's"
 *                    offline workspace (its unpushed backlog pushes on
 *                    connect — the durable local op log);
 *  5. "ready"      — the shell over a WorkerClient (OPFS-persisted store):
 *                    transparent topbar + sidebar straight on the background
 *                    canvas, one floating content card (PageCard) hosting
 *                    the node view, and the Ctrl/Cmd+K command palette.
 *                    "Work offline" skips 1–4 entirely: a local workspace
 *                    with no server, sync pending until a later login
 *                    adopts it.
 *
 * The shell components live in ./components (TopBar, Sidebar, PageCard,
 * CommandPalette); App stays composition + boot phases.
 *
 * The session token travels in the credential slot the relay API key used
 * to occupy (X-API-Key / Bearer); the operator API key keeps working for
 * the CLI. After connect the WS acceleration path is wired (startRealtime)
 * and the topbar polls the worker's sync status.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";

import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";

import { WorkspaceClient, type SyncStatusSnapshot } from "@/core/workspace-client.js";
import { WorkerClient } from "@/core/worker-client.js";
import {
  createWorkspace,
  fetchMe,
  fetchNodeLocation,
  fetchServerInfo,
  listWorkspaces,
  login,
  logout,
  setupAccount,
  type AccountUser,
  type WorkspaceEntry,
} from "@/core/auth-api.js";

import { Icon } from "./Icon.js";
import { PageView } from "./PageView.js";
import { displayNameForSettings } from "./dateDisplay.js";
import { ClassView } from "./ClassView.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { PageCard } from "./components/PageCard.js";
import { dayNodeId, SYSTEM_CLASS_UUIDS } from "@notees/domain";
import { Breadcrumbs } from "./components/Breadcrumbs.js";
import { FocusedBlockView } from "./components/FocusedBlockView.js";
import { NAV_ENTRIES, Sidebar, type NavKey } from "./components/Sidebar.js";
import { JournalsView } from "./components/JournalsView.js";
import { CalendarPopup } from "./components/ui/CalendarPopup.js";
import { TopBar } from "./components/TopBar.js";
import { QuickAddModal } from "./components/modals/QuickAddModal.js";
import { WorkspacesView } from "./components/WorkspacesView.js";
import { UserSettingsModal } from "./components/modals/UserSettingsModal.js";
import { applyAppearance, readDeviceSetting, useDeviceSetting } from "./components/modals/deviceSettings.js";
import { BackendUnavailableOverlay } from "./components/ui/BackendUnavailableOverlay.js";
import { Button } from "./components/ui/Button.js";
import { NotificationToaster } from "./components/ui/NotificationToaster.js";
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
 * Hub routes: each NAVIGATION entry has a URL (`/journal`, `/inbox`, …) so a
 * reload or deep link boots straight into that hub. `/journals` is accepted
 * as a friendly alias.
 */
const NAV_PATHS: Record<string, NavKey> = {
  journal: "journal",
  journals: "journal",
  inbox: "inbox",
  pages: "pages",
  classes: "classes",
  whiteboards: "whiteboards",
  tasks: "tasks",
};

export function navFromPath(pathname: string): NavKey | null {
  const key = pathname.replace(/^\//, "").replace(/\/$/, "").toLowerCase();
  return NAV_PATHS[key] ?? null;
}

export function pathForNav(nav: NavKey): string {
  return `/${nav}`;
}

/**
 * Initial view: a hub URL in the address bar wins; otherwise the journal
 * feed is the default ("open in journal view") with the device-local
 * "default view" preference overriding it (legacy choices that have no hub
 * in this build land on Pages).
 */
function initialNav(): NavKey {
  const fromPath = navFromPath(window.location.pathname);
  if (fromPath !== null) return fromPath;
  const view = readDeviceSetting<string | null>("defaultView", null);
  if (view === null) return "journal";
  if (view === "journal" || view === "today") return "journal";
  return "pages";
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
  if (node.nodeType === "block") {
    return <FocusedBlockView client={client} blockId={nodeId} onOpenNode={onOpenNode} />;
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
  /** Manage Workspaces view, opened from the workspace switcher popup. */
  const [managerOpen, setManagerOpen] = useState(false);
  /** True when the live credential is a session (API-key management needs one). */
  const [sessionSignedIn, setSessionSignedIn] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [workspaceName, setWorkspaceName] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    // Default: open on desktop, closed on narrow screens. jsdom lacks
    // matchMedia — default open there.
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
    return window.matchMedia("(min-width: 801px)").matches;
  });
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** Top-bar calendar popup (the popup needs the client, so it renders here). */
  const [calendarOpen, setCalendarOpen] = useState(false);
  const calendarButtonRef = useRef<HTMLButtonElement | null>(null);
  const [firstDayOfWeek] = useDeviceSetting("firstDayOfWeek", 1);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [client, setClient] = useState<AnyClient | null>(null);
  const [offline, setOffline] = useState(false);
  const [storeMode, setStoreMode] = useState<StoreMode>("in-process");
  const [selectedPageId, setSelectedPageId] = useState<string | null>(() => {
    // Deep link: /<uuid> in the address bar opens that node once synced.
    const match = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
      window.location.pathname,
    );
    return match !== null ? match[1]! : null;
  });
  const [activeNav, setActiveNav] = useState<NavKey>(initialNav);
  const [syncStatus, setSyncStatus] = useState<SyncStatusSnapshot>(INITIAL_SYNC_STATUS);
  const [pagesVersion, setPagesVersion] = useState(0);

  // Browser tab title follows the open node: "NAME - Notees" (pagesVersion
  // keeps it fresh across renames and sync updates). Date pages format per
  // the user's dateFormat preference.
  useEffect(() => {
    if (client === null || selectedPageId === null) {
      document.title = "Notees";
      return;
    }
    const node = client.getNode(selectedPageId);
    const name = node !== undefined ? displayNameForSettings(node) : "";
    document.title = name !== "" ? `${name} - Notees` : "Notees";
  }, [client, selectedPageId, pagesVersion]);
  const [quickAddOpen, setQuickAddOpen] = useState(false);

  /** Open a node, record it in Recents (the Sidebar wraps this), and sync the URL. */
  function openPage(id: string): void {
    setSelectedPageId(id);
    window.history.pushState({ node: id }, "", `/${id}`);
  }

  /** Back/forward navigation drives the selection / views. */
  useEffect(() => {
    const onPopState = () => {
      const path = window.location.pathname;
      if (path === "/workspaces") {
        setManagerOpen(true);
        return;
      }
      if (path === "/login" || path === "/auth") {
        setManagerOpen(false);
        setSelectedPageId(null);
        return;
      }
      const nav = navFromPath(path);
      if (nav !== null) {
        setManagerOpen(false);
        setActiveNav(nav);
        setSelectedPageId(null);
        return;
      }
      const match = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(path);
      setManagerOpen(false);
      setSelectedPageId(match !== null ? match[1]! : null);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Appearance (theme / OLED / accent) is device-local; apply it to <html>
  // on boot (index.html already applied it pre-paint) and re-apply when the
  // OS color scheme flips while "system" theme is selected.
  useEffect(() => {
    applyAppearance();
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyAppearance();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  // Ctrl/Cmd+Shift+N — the global quick-capture shortcut (Quick Add).
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "n" || !event.shiftKey || !(event.ctrlKey || event.metaKey)) {
        return;
      }
      const target = event.target as HTMLElement | null;
      // Don't steal the gesture from text fields (the browser needs
      // Ctrl+Shift+N nowhere else, but a focused editor should keep typing).
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      event.preventDefault();
      setQuickAddOpen(true);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

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
      // Keep meaningful URLs across connect: a hub route (/journal, /inbox, …)
      // or a node deep link survives workspace (re)connects; anything else
      // (e.g. /workspaces after entering) resolves to the app root.
      const bootPath = window.location.pathname;
      const keepPath =
        navFromPath(bootPath) !== null ||
        /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bootPath);
      window.history.pushState({ view: "app" }, "", keepPath ? bootPath : "/");
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
            setPhase({ name: "workspaces", user: me });
            return;
          }
          // Deep-link resolution: a /<node-uuid> URL names a node that may
          // live in another of the account's workspaces. Connect straight to
          // the holder instead of the remembered workspace.
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
      window.history.pushState({ view: "workspaces" }, "", "/workspaces");
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
    window.history.pushState({ view: "login" }, "", "/login");
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
              <Button type="submit" variant="primary">
                Sign in with key
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setApiKeyInput("");
                  setError(null);
                  setBootNote(null);
                  setPhase({ name: "server" });
                }}
              >
                Change server
              </Button>
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
              <Button type="submit" variant="primary">
                {phase.name === "setup" ? "Create account" : isLogin ? "Sign in" : "Continue"}
              </Button>
              {phase.name === "server" && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleWorkOffline()}
                >
                  Work offline
                </Button>
              )}
              {isLogin && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setEmail("");
                    setPassword("");
                    setError(null);
                    setBootNote(null);
                    setPhase({ name: "server" });
                  }}
                >
                  Change server
                </Button>
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

  if (phase.name === "workspaces" || managerOpen) {
    const enteringFromApp = phase.name === "ready" && client !== null;
    return (
      <WorkspacesView
        serverUrl={serverUrl}
        credential={token}
        user={user}
        activeWorkspaceId={readStored(STORAGE_KEYS.workspaceId) !== "" && enteringFromApp ? readStored(STORAGE_KEYS.workspaceId) : null}
        onEnter={(workspaceId, name) => {
          setManagerOpen(false);
          if (enteringFromApp) {
            setSelectedPageId(null);
            void connect(serverUrl, token, workspaceId, {
              isOffline: false,
              credentialType: sessionSignedIn ? "session" : "apikey",
              label: name,
            });
          } else {
            void connect(serverUrl, token, workspaceId, {
              isOffline: false,
              credentialType: authTab === "apikey" ? "apikey" : "session",
              label: name,
            });
          }
        }}
        onRenamed={(_id, name) => setWorkspaceName(name)}
        onOpenUserSettings={
          sessionSignedIn && user !== null ? () => setSettingsOpen(true) : undefined
        }
        onSignOut={() => void handleSignOut()}
        onClose={enteringFromApp ? () => setManagerOpen(false) : undefined}
      />
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

  return (
    <div className={sidebarOpen ? "nt-app nt-sidebar-open" : "nt-app"}>
      <TopBar
        syncStatus={syncStatus}
        breadcrumbs={
          selectedPageId !== null ? (
            <Breadcrumbs client={client} nodeId={selectedPageId} onOpenNode={openPage} showCurrent />
          ) : null
        }
        sidebarOpen={sidebarOpen}
        rightPanelOpen={rightPanelOpen}
        calendarOpen={calendarOpen}
        onToggleCalendar={() => setCalendarOpen((open) => !open)}
        calendarButtonRef={calendarButtonRef}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        onToggleRightPanel={() => setRightPanelOpen((open) => !open)}
      />
      {calendarOpen && (
        <CalendarPopup
          isOpen
          onClose={() => setCalendarOpen(false)}
          anchorRef={calendarButtonRef}
          firstDayOfWeek={firstDayOfWeek}
          hasNote={(iso) => client.getNodeRaw(dayNodeId(iso)) !== undefined}
          onSelectDay={(iso) => {
            void client.ensureDateChain(iso).then(({ day }) => openPage(day));
            setCalendarOpen(false);
          }}
          onSelectMonth={(year, month) => {
            const iso = `${year}-${String(month).padStart(2, "0")}-01`;
            void client.ensureDateChain(iso).then(({ month: monthId }) => openPage(monthId));
            setCalendarOpen(false);
          }}
          onSelectYear={(year) => {
            void client.ensureDateChain(`${year}-01-01`).then(({ year: yearId }) => openPage(yearId));
            setCalendarOpen(false);
          }}
        />
      )}
      <div className="nt-body">
        <Sidebar
          client={client}
          workspaceName={workspaceName}
          workspaceId={readStored(STORAGE_KEYS.workspaceId)}
          serverUrl={serverUrl}
          credential={token}
          user={user}
          offline={offline}
          showSettings={sessionSignedIn && user !== null && !offline}
          onOpenSettings={() => setSettingsOpen(true)}
          selectedPageId={selectedPageId}
          activeNav={activeNav}
          onSelectNav={(key) => {
            setActiveNav(key);
            setSelectedPageId(null);
            window.history.pushState({ node: null, nav: key }, "", pathForNav(key));
          }}
          onRequestSearch={() => setPaletteOpen(true)}
          onOpenPage={openPage}
          onSwitchWorkspace={(id, name) => {
            setSelectedPageId(null);
            void connect(serverUrl, token, id, {
              isOffline: false,
              credentialType: sessionSignedIn ? "session" : "apikey",
              label: name,
            });
          }}
          onManageWorkspaces={() => {
            window.history.pushState({ view: "workspaces" }, "", "/workspaces");
            setManagerOpen(true);
          }}
          onSignOut={() => void handleSignOut()}
          onRenameWorkspace={(id, name) => {
            if (id === readStored(STORAGE_KEYS.workspaceId)) setWorkspaceName(name);
          }}
        />
        <PageCard>
          {selectedPageId !== null ? (
            <NodeView client={client} nodeId={selectedPageId} onOpenNode={openPage} />
          ) : activeNav === "journal" ? (
            <JournalsView client={client} onOpenPage={openPage} />
          ) : (
            <HubView client={client} nav={activeNav} onOpenNode={openPage} />
          )}
        </PageCard>
        {rightPanelOpen && (
          <aside className="nt-right-card" aria-label="Right sidebar">
            <div className="nt-right-card-placeholder" />
          </aside>
        )}
      </div>
      <CommandPalette
        client={client}
        open={paletteOpen}
        onRequestOpen={() => setPaletteOpen(true)}
        onClose={() => setPaletteOpen(false)}
        onOpenNode={openPage}
        onNewPage={() => void handleNewPage()}
        onSignOut={() => void handleSignOut()}
      />
      {settingsOpen && sessionSignedIn && user !== null && !offline && (
        <UserSettingsModal
          isOpen={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          serverUrl={serverUrl}
          token={token}
          user={user}
          onSignOut={() => void handleSignOut()}
        />
      )}
      {quickAddOpen && (
        <QuickAddModal isOpen={quickAddOpen} onClose={() => setQuickAddOpen(false)} client={client} />
      )}
      <BackendUnavailableOverlay syncStatus={syncStatus} />
      <NotificationToaster />
    </div>
  );
}

/** Nav hub: the main-view list behind each NAVIGATION entry. */
function HubView({
  client,
  nav,
  onOpenNode,
}: {
  client: AnyClient;
  nav: NavKey;
  onOpenNode: (nodeId: string) => void;
}) {
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);
  const classes = client.listClasses();
  const assetClassId = classes.find((cls) => cls.name === "asset")?.id ?? SYSTEM_CLASS_UUIDS.asset;
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
  const entry = NAV_ENTRIES.find((e) => e.key === nav);
  const items =
    nav === "journal"
      ? journalPages
      : nav === "classes"
        ? classes
        : nav === "whiteboards"
          ? whiteboardPages
          : nav === "tasks"
            ? taskPages
            : nav === "inbox"
              ? pages.filter((page) => !sectionIds.has(page.id) && page.classIds.length === 0)
              : pages.filter((page) => !sectionIds.has(page.id));
  const byClass = new Map(classes.map((cls) => [cls.id, cls]));
  return (
    <div className="nt-hub">
      <header className="nt-hub-header">
        {entry !== undefined && <Icon path={entry.icon} size={1.2} className="nt-hub-icon" />}
        <h1 className="nt-hub-title">{entry?.label ?? "Pages"}</h1>
        <span className="nt-hub-count">{items.length}</span>
      </header>
      <ul className="nt-hub-list">
        {items.map((node) => {
          const icon =
            nav === "classes"
              ? (node.icon ?? null)
              : (node.icon ?? node.classIds.map((c) => byClass.get(c)?.icon).find((i) => i) ?? null);
          return (
            <li key={node.id}>
              <button type="button" className="nt-hub-item" onClick={() => onOpenNode(node.id)}>
                {icon !== null && icon !== undefined && (
                  <Icon path={icon} size={1} className="nt-hub-item-icon" />
                )}
                <span className="nt-hub-item-label">{displayNameForSettings(node) || node.id}</span>
              </button>
            </li>
          );
        })}
        {items.length === 0 && <li className="nt-hub-empty">Nothing here yet.</li>}
      </ul>
    </div>
  );
}
