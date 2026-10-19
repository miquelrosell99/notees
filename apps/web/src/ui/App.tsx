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
 * Session resume (fresh tab with a remembered credential) validates it
 * against the server first: 401/403 clears it and lands on the sign-in
 * screen, but a server that does not answer keeps the credential and opens
 * the remembered workspace from its local copy — the boot is local-first,
 * the sync-status banner reports "working locally until it recovers", and
 * the realtime reconnect catches up when the server returns. The workspace
 * switcher and manager fall back the same way: the device-local registry
 * (workspace-registry.ts — the last server list + which workspaces hold a
 * copy here) lists every locally-copied workspace while the server can't
 * answer. Only sign-out, "Disconnect & forget", or a rejected credential
 * returns to screen 1.
 *
 * The shell components live in ./components (TopBar, Sidebar, PageCard,
 * CommandPalette); App stays composition + boot phases.
 *
 * The session token travels in the credential slot the relay API key used
 * to occupy (X-API-Key / Bearer); the operator API key keeps working for
 * the CLI. After connect the WS acceleration path is wired (startRealtime)
 * and the topbar polls the worker's sync status.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { WorkspaceClient, type ClientNode, type SyncStatusSnapshot } from "@/core/workspace-client.js";
import { EMPTY_UNDO_STATE, type UndoUiState } from "@/core/undo-journal.js";
import {
  rememberWorkspaceList,
  rememberWorkspaceName,
  rememberedWorkspaceList,
  rememberedWorkspaceName,
} from "@/core/workspace-registry.js";
import {
  createWorkspace,
  fetchMe,
  fetchNodeLocation,
  fetchServerInfo,
  listWorkspaces,
  login,
  logout,
  setupAccount,
  signup,
  AuthRequestError,
  type AccountUser,
  type WorkspaceEntry,
} from "@/core/auth-api.js";

import { Icon } from "./Icon.js";
import { NodeView } from "./NodeView.js";
import { SearchPage } from "./SearchPage.js";
import { NodeCardFrame } from "./components/NodeCardFrame.js";
import { displayNameForSettings } from "./dateDisplay.js";
import { DeckView } from "./presentation/DeckView.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { PageCard } from "./components/PageCard.js";
import type { ShareTarget } from "./components/NodeMenuButton.js";
import { dayNodeId, rendersAsInlineBlock, rendersWithDocumentChrome } from "@notees/domain";
import { Breadcrumbs } from "./components/Breadcrumbs.js";
import { NAV_ENTRIES, Sidebar, recordRecent, type NavKey } from "./components/Sidebar.js";
import { NodeLinkMenuHost } from "./components/NodeLinkContextMenu.js";
import { FloatingEditorHost } from "./components/FloatingEditor.js";
import { NodeHoverPreviewHost } from "./components/NodeHoverPreview.js";
import { WorkspaceDndHost } from "./useWorkspaceDnd.js";
import { resolveAliasOpen } from "./components/aliasProperty.js";
import { JournalsView } from "./components/JournalsView.js";
import { CalendarView } from "./components/CalendarView.js";
import { todayIsoLocal } from "./components/calendarViewUtils.js";
import { CalendarPopup } from "./components/ui/CalendarPopup.js";
import { HistoryMenuPopup } from "./components/HistoryMenuPopup.js";
import { QueriesHub } from "./components/QueriesHub.js";
import { TrashHub } from "./components/TrashHub.js";
import { SharesHub } from "./components/SharesHub.js";
import { GraphView } from "./views/graph/GraphView.js";
import { TopBar } from "./components/TopBar.js";
import { WorkspaceSwitcher } from "./components/WorkspaceSwitcher.js";
import { NodeSelector } from "./components/pickers/NodeSelector.js";
import { createNodesWithClasses } from "./components/createNodesWithClasses.js";
import { QuickAddModal } from "./components/modals/QuickAddModal.js";
import { ClassCreateModal } from "./components/modals/ClassCreateModal.js";
import { MergeNodesModal } from "./components/modals/MergeNodesModal.js";
import { PropertyView } from "./components/PropertyView.js";
import { QuickCreateFab } from "./components/QuickCreateFab.js";
import { WorkspacesView } from "./components/WorkspacesView.js";
import {
  SettingsPage,
  SETTINGS_SECTIONS,
  pathForSettingsSection,
  settingsSectionFromPath,
  type SettingsSection,
} from "./components/SettingsPage.js";
import { SyncDetailsModal } from "./components/modals/SyncDetailsModal.js";
import { WorkspaceSettingsModal } from "./components/modals/WorkspaceSettingsModal.js";
import { applyAppearance, readDeviceSetting, toggleFocusMode, useDeviceSetting } from "./components/modals/deviceSettings.js";
import { useCondensedPreference } from "./viewPrefs.js";
import {
  STORAGE_KEYS,
  clearStored,
  initialServerUrl,
  readStored,
  sameHostServerUrl,
  writeStored,
} from "./app/storage.js";
import { BackendUnavailableOverlay } from "./components/ui/BackendUnavailableOverlay.js";
import { InProcessStoreBanner } from "./components/ui/InProcessStoreBanner.js";
import { Button } from "./components/ui/Button.js";
import { NotificationToaster } from "./components/ui/NotificationToaster.js";
import "./app.css";
import { moveRailCardOrder, persistRailCardOrder, readRailCardOrder } from "./app/railCardOrder.js";
import { HubView } from "./app/HubView.js";
import { useWorkspaceConnection } from "./app/useWorkspaceConnection.js";
import type { CredentialType } from "./app/store-connection.js";
import {
  drawerDismissHandler,
  focusModeExitHandler,
  focusModeKeyHandler,
  historyKeyHandler,
  historyNavKeyHandler,
  keymapChordHandler,
  openTodayKeyHandler,
  searchKeyHandler,
  undoRedoKeyHandler,
} from "./app/keymap.js";
import {
  currentNavUrl,
  initialNav,
  navFromPath,
  pathForNav,
  popStateNavHandler,
  pushSettingsSection,
  recordNavPop,
  recordNavPush,
  tabTitle,
  type NavStack,
} from "./app/routing.js";

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

/**
 * Field-wise snapshot compare. `status()` builds a fresh object every
 * call, so an unguarded setState re-rendered the whole app (and every
 * render-time store read under it) every 2s poll even when nothing moved.
 */
export function syncStatusEqual(a: SyncStatusSnapshot, b: SyncStatusSnapshot): boolean {
  return (
    a.status === b.status &&
    a.error === b.error &&
    a.pending === b.pending &&
    a.failed === b.failed &&
    a.quarantined === b.quarantined &&
    a.parked === b.parked &&
    a.realtime === b.realtime &&
    a.cursorSeq === b.cursorSeq
  );
}

export { NodeView } from "./NodeView.js";

export function App() {
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [displayName, setDisplayName] = useState("");
  const {
    client,
    clientRef,
    offline,
    storeMode,
    storeReason,
    sessionSignedIn,
    setSessionSignedIn,
    workspaceName,
    setWorkspaceName,
    phase,
    setPhase,
    error,
    setError,
    connect,
    closeClient,
  } = useWorkspaceConnection();
  const [hint, setHint] = useState<string | null>(null);
  /**
   * Same-host guess offered under the boot form after a failed probe
   * (TypeError only). Clicking the suggestion button is the only path to the
   * guess — the boot screen never silently re-routes.
   */
  const [serverSuggestion, setServerSuggestion] = useState<string | null>(null);
  const [user, setUser] = useState<AccountUser | null>(null);
  const [token, setToken] = useState(() => readStored(STORAGE_KEYS.sessionToken));
  const [authTab, setAuthTab] = useState<"account" | "apikey">("account");
  /**
   * NOTEES_SIGNUP_ENABLED as reported by /server-info: the login screen's
   * "No account yet? Create one" affordance renders only when the server
   * advertises it (the route 404s regardless when the flag is off).
   */
  const [signupEnabled, setSignupEnabled] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  /** The sync indicator's details modal (resync + conflicts). */
  const [syncDetailsOpen, setSyncDetailsOpen] = useState(false);
  /** The account popup's admin entry: the active workspace's settings (plugins tab). */
  const [adminSettingsOpen, setAdminSettingsOpen] = useState(false);
  /** Manage Workspaces view, opened from the workspace switcher popup. */
  const [managerOpen, setManagerOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    // Default: open on desktop, closed on narrow screens. jsdom lacks
    // matchMedia — default open there.
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
    // 801px is a deliberate non-register threshold (the register runs
    // 480/768/1024/1440) — it gates the sidebar's open-by-default state, and
    // behavior preservation beats breakpoint purity here.
    return window.matchMedia("(width >= 801px)").matches;
  });
  /**
   * Tap-outside drawer dismissal — the
   * predicate lives in the exported drawerDismissHandler (unit-tested); the
   * effect just wires it to the sidebar state.
   */
  useEffect(() => {
    if (!sidebarOpen) return;
    const onPress = drawerDismissHandler({
      isSidebarOpen: () => sidebarOpen,
      closeSidebar: () => setSidebarOpen(false),
    });
    document.addEventListener("pointerdown", onPress);
    return () => document.removeEventListener("pointerdown", onPress);
  }, [sidebarOpen]);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  /**
   * The session-only page-layout toggle (owner 2026-10-12): false renders
   * the panelled default (the properties sidebar rides the first column);
   * true renders the main content as in-flow sections (the compact layout).
   * Component state — never persisted; the app top bar's layout button
   * flips it and the icon names the current mode.
   */
  const [sectionsLayout, setSectionsLayout] = useState(false);
  /**
   * Right-sidebar peek cards (shift+click a block bullet): most recent first.
   * Re-clicking an open card brings it to the top; opening a card opens the
   * panel. Closing the last card closes the panel with it. The stack ORDER
   * is device-local (the recents-order precedent — `readRailCardOrder`): a
   * grip drag reorders it (the workspace drag session reports the gesture,
   * see useWorkspaceDnd), every change persists, and ids that no longer
   * exist in the current workspace are filtered out on connect.
   */
  const [sidebarCards, setSidebarCards] = useState<string[]>(() => readRailCardOrder());
  const openInSidebar = useCallback(
    (nodeId: string) => {
      // The redirect seam: a peek card opened on an alias shows the
      // terminal's card (the same resolution openPage applies).
      const live = clientRef.current;
      const resolved = live !== null ? resolveAliasOpen(live, nodeId) : nodeId;
      setSidebarCards((prev) => [resolved, ...prev.filter((id) => id !== resolved)]);
      setRightPanelOpen(true);
    },
    [],
  );
  function closeSidebarCard(nodeId: string): void {
    const next = sidebarCards.filter((id) => id !== nodeId);
    setSidebarCards(next);
    if (next.length === 0) setRightPanelOpen(false);
  }
  /**
   * The rail reorder report (the workspace drag session's callback): a pure
   * stack move — no-ops return the same reference and never reach the
   * persistence effect.
   */
  const reorderSidebarCard = useCallback(
    (activeId: string, targetId: string, position: "before" | "after") => {
      setSidebarCards((prev) => moveRailCardOrder(prev, activeId, targetId, position));
    },
    [],
  );
  // The card order persists device-locally on every change (open, close,
  // reorder, stale-id filtering) — one write seam, the recents precedent.
  useEffect(() => {
    persistRailCardOrder(sidebarCards);
  }, [sidebarCards]);
  /**
   * Post-delete navigation: a deleted page/class lands on its parent page
   * when one exists, otherwise on the workspace default view (today's page /
   * journal / pages hub). Inline blocks vanish in place — no navigation.
   */
  function handleNodeDeleted(node: ClientNode): void {
    if (rendersAsInlineBlock(node, clientRef.current?.getNode(node.parentId ?? ""))) return;
    if (node.parentId !== null) {
      openPage(node.parentId);
      return;
    }
    openWorkspaceLanding();
  }
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** #14 — the palette's "New class…" command opens the creation modal. */
  const [classCreateOpen, setClassCreateOpen] = useState(false);
  /** The palette's Properties section: the picked schema's PropertyView. */
  const [propertyViewFor, setPropertyViewFor] = useState<string | null>(null);
  /** The palette's "Merge current page into…" command (in-process store only —
   *  the planner reads the local SQLite database directly). */
  const [mergeOpen, setMergeOpen] = useState(false);
  /**
   * The session undo journal's chrome state (availability + labels).
   * Refreshed on a macrotask coalescer off every client notification (the
   * worker round-trip is cheap; the journal lives worker-side, per tab).
   */
  const [undoUi, setUndoUi] = useState<UndoUiState>(EMPTY_UNDO_STATE);
  /** The sync snapshot the keymap chord reads synchronously (may lag the
   *  worker by a macrotask — an undo on an empty journal no-ops honestly). */
  const undoUiRef = useRef<UndoUiState>(EMPTY_UNDO_STATE);
  const undoRefreshTimer = useRef<number | null>(null);
  const scheduleUndoRefresh = useCallback(() => {
    if (undoRefreshTimer.current !== null) return;
    undoRefreshTimer.current = window.setTimeout(() => {
      undoRefreshTimer.current = null;
      const live = clientRef.current;
      void Promise.resolve(live === null ? EMPTY_UNDO_STATE : live.undoState()).then(
        (resolved) => {
          undoUiRef.current = resolved;
          setUndoUi(resolved);
        },
      );
    }, 0);
  }, []);
  /** Top-bar calendar popup (the popup needs the client, so it renders here). */
  const [calendarOpen, setCalendarOpen] = useState(false);
  const calendarButtonRef = useRef<HTMLButtonElement | null>(null);
  /** The browsable history popup over the undo journal. */
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyButtonRef = useRef<HTMLButtonElement | null>(null);
  const [firstDayOfWeek] = useDeviceSetting("firstDayOfWeek", 1);
  /** Focus mode (#12) — device-local; the data attribute drives the shell dim. */
  const [focusMode, setFocusMode] = useDeviceSetting("focusMode", false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  /**
   * Shares: the coordinates the Share… surface needs. Absent in
   * offline mode (there is no server to mint against) — the menu item and
   * modal hide themselves without it.
   */
  const shareTarget: ShareTarget | undefined =
    !offline && serverUrl.trim() !== "" && token !== ""
      ? { serverUrl, credential: token }
      : undefined;
  const [selectedPageId, setSelectedPageId] = useState<string | null>(() => {
    // Deep link: /<uuid> in the address bar opens that node once synced.
    const match = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
      window.location.pathname,
    );
    return match !== null ? match[1]! : null;
  });
  /**
   * The condensed layer's per-page pref for the ACTIVE page (owner
   * 2026-10-15): the TopBar toggle and the command-palette row both flip
   * this; PageView reads the same seam for the page body. Selection-null
   * reads the inert "condensed." key — never written, so the toggle stays
   * hidden (the onToggleLayout gating idiom: no eligible page, no button).
   */
  const [condensedActive, setCondensedPref] = useCondensedPreference(selectedPageId ?? "");
  const [activeNav, setActiveNav] = useState<NavKey>(initialNav);
  /**
   * The in-app Back/Forward stack behind the top-bar arrows: our own
   * entries + cursor (the browser stack reaches beyond the app — see
   * recordNavPush/recordNavPop). Boots at the deep-linked URL.
   */
  const [navStack, setNavStack] = useState<NavStack>(() => ({
    entries: [currentNavUrl()],
    index: 0,
  }));

  /** Every in-app navigation funnels here: record on our stack, then pushState. */
  function pushNav(url: string, state: Record<string, unknown>): void {
    setNavStack((stack) => recordNavPush(stack, url));
    window.history.pushState(state, "", url);
  }
  /**
   * The settings page route: non-null while the URL is /settings/<section>
   * (deep link at boot, section nav, back/forward). Takes precedence over
   * the hub views in the PageCard slot, like an open node.
   */
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(() =>
    settingsSectionFromPath(window.location.pathname),
  );
  /**
   * The full-page search route: true while the URL is /search (deep link at
   * boot, the Ctrl/Cmd+Shift+F chord, the palette's "Search all for …" row,
   * back/forward). Takes the PageCard slot ahead of the hubs, like a
   * settings section; an initial query rides the ?q= param, read on mount.
   */
  const [searchOpen, setSearchOpen] = useState(
    () => window.location.pathname === "/search",
  );
  const [syncStatus, setSyncStatus] = useState<SyncStatusSnapshot>(INITIAL_SYNC_STATUS);
  const [pagesVersion, setPagesVersion] = useState(0);
  /**
   * Presentation mode: the node id currently decked, or null.
   * Session-local device state — never persisted, never on the wire.
   */
  const [presentingId, setPresentingId] = useState<string | null>(null);
  const selectedPageIdRef = useRef<string | null>(null);
  selectedPageIdRef.current = selectedPageId;

  // Browser tab title: the ONE writer — the tabTitle rule (law 9; exported
  // and unit-tested). pagesVersion keeps the open node's title fresh across
  // renames and sync updates; searchOpen/activeNav name the selection-less
  // surfaces (hubs and the full-page search).
  useEffect(() => {
    document.title = tabTitle({
      clientPresent: client !== null,
      selectedPageId,
      settingsSection,
      searchOpen,
      activeNav,
      nodeName:
        client !== null && selectedPageId !== null
          ? (() => {
              const node = client.getNode(selectedPageId);
              return node !== undefined
                ? displayNameForSettings(node, (classId) => client.getDisplayName(classId))
                : "";
            })()
          : "",
    });
  }, [client, selectedPageId, pagesVersion, settingsSection, searchOpen, activeNav]);
  // The persisted rail order may carry ids from another workspace (the key
  // is device-global, the recents precedent): drop the ones this client
  // doesn't know — the persistence effect writes the filtered list through.
  useEffect(() => {
    if (client === null) return;
    setSidebarCards((prev) => {
      const next = prev.filter((id) => client.getNode(id) !== undefined);
      return next.length === prev.length ? prev : next;
    });
  }, [client]);
  const [quickAddOpen, setQuickAddOpen] = useState(false);

  /**
   * The RAW open: sync the URL, the selection and Recents to exactly `id` —
   * no alias resolution. The identity-level path: browser deep links and
   * back/forward land here, and the aliases UI's NAVIGATE (open the alias
   * node's OWN view) is the one in-app caller that bypasses the redirect.
   */
  function openPageAt(id: string): void {
    setSettingsSection(null);
    setSearchOpen(false);
    setSelectedPageId(id);
    pushNav(`/${id}`, { node: id });
    recordRecent(id);
  }

  /**
   * Open a settings section: state + URL together (the pushState seam the
   * popstate handler maps back on back/forward). Clears the open page and
   * the search route — the PageCard slot checks the selection FIRST, so a
   * stale selectedPageId would keep winning the slot over the settings
   * page (the "Advanced settings does nothing" bug).
   */
  function openSettingsSection(section: SettingsSection): void {
    setSettingsSection(section);
    setSearchOpen(false);
    setSelectedPageId(null);
    setNavStack((stack) => recordNavPush(stack, pathForSettingsSection(section)));
    pushSettingsSection(section);
  }

  /**
   * Open a node: THE navigation funnel — every open surface routes through
   * here (breadcrumbs, links, bullets, sidebar rows, backlink/query result
   * rows, the command palette, graph clicks). Node aliases resolve to
   * their terminal here (the single redirect seam — resolveAliasOpen), so
   * a mention of an alias opens the MAIN page's view.
   */
  function openPage(id: string): void {
    const live = clientRef.current;
    openPageAt(live !== null ? resolveAliasOpen(live, id) : id);
  }

  /**
   * Open the full-page search surface: state + URL together (the pushState
   * seam the popstate handler maps back on back/forward). An optional query
   * rides the ?q= param — the palette's "Search all for …" handoff; the
   * SearchPage reads it on mount.
   */
  function openSearchPage(query?: string): void {
    setSearchOpen(true);
    setSettingsSection(null);
    setSelectedPageId(null);
    const path =
      query !== undefined && query !== "" ? `/search?q=${encodeURIComponent(query)}` : "/search";
    pushNav(path, { view: "search" });
  }

  /**
   * Landing navigation for a workspace opened from the manager: the device's
   * "default view" preference owns the URL and first screen — today's day
   * page (chain ensured, page opened), the journal feed, or a hub fallback
   * for the remaining choices (no graph surface in this slice yet).
   */
  function openWorkspaceLanding(): void {
    const live = clientRef.current;
    const view = readDeviceSetting<string | null>("defaultView", "today");
    const toHub = (nav: NavKey, path: string) => {
      setSettingsSection(null);
      setSearchOpen(false);
      setActiveNav(nav);
      setSelectedPageId(null);
      pushNav(path, { nav });
    };
    if (view === "today" && live !== null) {
      const now = new Date();
      const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
        now.getDate(),
      ).padStart(2, "0")}`;
      void live.ensureDateChain(iso).then(({ day }) => openPage(day));
      return;
    }
    if (view === "journal") {
      toHub("journal", "/journals");
      return;
    }
    if (view === "graph") {
      toHub("graph", "/graph");
      return;
    }
    // "all-pages" / legacy values: the Pages hub.
    toHub("pages", "/pages");
  }

  /** Back/forward navigation drives the selection / views / settings section. */
  useEffect(() => {
    const onPopState = popStateNavHandler({
      openManager: () => setManagerOpen(true),
      closeManager: () => setManagerOpen(false),
      setNav: setActiveNav,
      setNode: setSelectedPageId,
      setSettingsSection,
      setSearch: setSearchOpen,
      onNavigated: (url) => setNavStack((stack) => recordNavPop(stack, url)),
    });
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

  // Ctrl/Cmd+Alt+Enter — present the open page. Capacities'
  // Ctrl+Alt+P collides with the reserved "add property" chord (and the
  // browser's private-window binding); Ctrl+Alt+Enter is free in both the
  // keymap row and the tree.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !event.altKey || !(event.ctrlKey || event.metaKey)) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      const openId = selectedPageIdRef.current;
      if (openId === null) return;
      const live = clientRef.current;
      const node = live?.getNode(openId);
      if (node === undefined || !rendersWithDocumentChrome(node, live?.getNode(node.parentId ?? "")))
        return;
      event.preventDefault();
      setPresentingId(openId);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Ctrl/Cmd+Shift+T — open today's daily page.
  useEffect(() => {
    const handler = openTodayKeyHandler({
      client: () => clientRef.current,
      openPage,
    });
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Ctrl/Cmd+Shift+F — the full-page search surface (/search).
  useEffect(() => {
    const handler = searchKeyHandler({ onOpen: () => openSearchPage() });
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Alt+← / Alt+→ — in-app Back/Forward through the history stack.
  useEffect(() => {
    const handler = historyNavKeyHandler();
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Ctrl/Cmd+N / Ctrl/Cmd+, / Ctrl/Cmd+\ — the keymap-breadth chords.
  useEffect(() => {
    const handler = keymapChordHandler({
      client: () => clientRef.current,
      openPage,
      // The quick-tweaks modal is gone (owner 2026-10-14): the chord opens
      // the full settings page at Appearance, like the sidebar gear.
      openSettings: () => openSettingsSection("appearance"),
      toggleSidebar: () => setSidebarOpen((open) => !open),
    });
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Ctrl/Cmd+Z undo / Ctrl/Cmd+Shift+Z (or Ctrl/Cmd+Y) redo — the session
  // journal chords. The chord handler reads the coalesced undo
  // snapshot synchronously; the write itself runs through the normal path
  // and the worker's "changed" notification re-syncs the snapshot.
  useEffect(() => {
    const handler = undoRedoKeyHandler({
      undoState: () => undoUiRef.current,
      onUndo: () => {
        const live = clientRef.current;
        if (live === null) return;
        void live.undo().catch((error: unknown) => {
          console.error("undo failed:", error);
        });
        scheduleUndoRefresh();
      },
      onRedo: () => {
        const live = clientRef.current;
        if (live === null) return;
        void live.redo().catch((error: unknown) => {
          console.error("redo failed:", error);
        });
        scheduleUndoRefresh();
      },
    });
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [scheduleUndoRefresh]);

  // Ctrl/Cmd+Shift+H — the history popup chord. Toggles the popup;
  // the popup itself closes on its own dismissal layer.
  useEffect(() => {
    const handler = historyKeyHandler({
      onToggle: () => setHistoryOpen((open) => !open),
    });
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Ctrl/Cmd+Alt+F — the focus-mode toggle chord (#12). The shared toggle
  // persists, applies the data attribute, and broadcasts the change.
  useEffect(() => {
    const handler = focusModeKeyHandler({
      onToggle: () => setFocusMode(toggleFocusMode()),
    });
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [setFocusMode]);

  // Esc — exit focus mode (#12); registered only while the mode is on.
  useEffect(() => {
    const handler = focusModeExitHandler({
      focusMode: () => focusMode,
      onExit: () => setFocusMode(false),
    });
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [focusMode, setFocusMode]);

  const serverUrlRef = useRef(serverUrl);
  serverUrlRef.current = serverUrl;
  /**
   * The top bar's "New" class picker (owner 2026-10-06 — the sidebar hosts
   * its own picker beside its New button; both ride the same create flow).
   */
  const [newPickerOpen, setNewPickerOpen] = useState(false);
  const newButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (client === null) return;
    undoUiRef.current = EMPTY_UNDO_STATE;
    setUndoUi(EMPTY_UNDO_STATE);
    scheduleUndoRefresh();
    return client.subscribe(() => {
      setPagesVersion((v) => v + 1);
      scheduleUndoRefresh();
    });
  }, [client, scheduleUndoRefresh]);

  // Poll the (cheap) status snapshot on a cadence and on every worker
  // notification; state is only set when a field actually changed —
  // the field-wise guard keeps the 2s cadence from re-rendering the tree).
  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const snapshot = await client.status();
        // Skip no-op updates: a fresh object every poll would re-render the
        // whole app twice a second (this used to re-run every
        // render-time store read in the tree).
        if (!cancelled) setSyncStatus((prev) => (syncStatusEqual(prev, snapshot) ? prev : snapshot));
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
      // same-host fallback (the owner ruling: never re-route without an
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
    closeClient();
    pushNav("/login", { view: "login" });
    setPhase({ name: "server" });
  }

  /**
   * Sync tab → "Disconnect & forget": drop every stored credential for this
   * server, sign out, and land back on the boot form with the field reset to
   * the same-origin guess.
   */
  function handleForgetServer() {
    clearStored(STORAGE_KEYS.serverUrl);
    clearStored(STORAGE_KEYS.sessionToken);
    clearStored(STORAGE_KEYS.apiKey);
    setToken("");
    setUser(null);
    setSessionSignedIn(false);
    closeClient();
    setServerUrl(initialServerUrl());
    setError(null);
    setHint(null);
    setServerSuggestion(null);
    pushNav("/login", { view: "login" });
    setPhase({ name: "server" });
  }

  /**
   * Sync tab → "Connect to a different server": leave the shell, then run the
   * exact connect path the boot form uses (probe → setup/login, or the same
   * error/suggestion state on failure).
   */
  function handleConnectServer(url: string) {
    closeClient();
    setServerUrl(url);
    setPhase({ name: "server" });
    void connectTo(url);
  }

  async function handleNewPage(title?: string) {
    if (client === null) return;
    const id = await client.createObject({ isEmbedded: false, name: title ?? "Untitled" });
    setSelectedPageId(id);
  }

  const localWorkspaceId = readStored(STORAGE_KEYS.localWorkspaceId);
  const showDeviceWorkspace =
    phase.name === "workspaces" &&
    localWorkspaceId !== "" &&
    !workspaces.some((ws) => ws.id === localWorkspaceId);

  if (
    phase.name === "server" ||
    phase.name === "setup" ||
    phase.name === "login" ||
    phase.name === "signup"
  ) {
    const isLogin = phase.name === "login";
    const isSignup = phase.name === "signup";
    const isNewAccount = phase.name === "setup" || isSignup;
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
            <p className="nt-bootstrap-subtitle">Connect to a Notees sync server — or work offline.</p>
          )}
          {phase.name === "setup" && (
            <p className="nt-bootstrap-subtitle">Initial setup — create the admin account</p>
          )}
          {isSignup && (
            <p className="nt-bootstrap-subtitle">Create an account on this server</p>
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
                  setPhase({ name: "server" });
                }}
              >
                Change server
              </Button>
              {hint !== null && <p className="nt-hint">{hint}</p>}
              {error !== null && <p className="nt-error" role="alert">{error}</p>}
            </form>
          ) : (
            <form
              className="nt-form"
              onSubmit={(e) =>
                void (phase.name === "setup"
                  ? handleSetup(e)
                  : isSignup
                    ? handleSignup(e)
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
                      autoComplete={isNewAccount ? "new-password" : "current-password"}
                      required
                    />
                  </label>
                </>
              )}
              {isNewAccount && (
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
                {isNewAccount ? "Create account" : isLogin ? "Sign in" : "Continue"}
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
                    setPhase({ name: "server" });
                  }}
                >
                  Change server
                </Button>
              )}
              {isLogin && signupEnabled && (
                <p className="nt-hint">
                  No account yet?{" "}
                  <button
                    type="button"
                    className="nt-link"
                    onClick={() => {
                      setPassword("");
                      setPasswordConfirm("");
                      setError(null);
                      setPhase({ name: "signup" });
                    }}
                  >
                    Create one
                  </button>
                </p>
              )}
              {isSignup && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setPassword("");
                    setPasswordConfirm("");
                    setError(null);
                    setPhase({ name: "login" });
                  }}
                >
                  Back to sign in
                </Button>
              )}
              {hint !== null && <p className="nt-hint">{hint}</p>}
              {error !== null && <p className="nt-error" role="alert">{error}</p>}
            </form>
          )}
          {serverSuggestion !== null && (
            <div className="nt-server-suggestion">
              <p className="nt-hint">
                This app is usually served by the same machine as the sync
                server — the address below is this origin itself.
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleServerSuggestion()}
              >
                Try {serverSuggestion} instead
              </Button>
            </div>
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
          const connectOptions = enteringFromApp
            ? { isOffline: false, credentialType: (sessionSignedIn ? "session" : "apikey") as CredentialType, label: name }
            : {
                isOffline: false,
                credentialType: (authTab === "apikey" ? "apikey" : "session") as CredentialType,
                label: name,
              };
          if (enteringFromApp) {
            setSelectedPageId(null);
          }
          // The device "default view" preference owns the landing: after the
          // connect resolves, navigate to today's page / journal / hub and
          // rewrite the URL (the manager's /workspaces path never survives).
          void connect(serverUrl, token, workspaceId, connectOptions).then(() =>
            openWorkspaceLanding(),
          );
        }}
        onRenamed={(id, name) => {
          rememberWorkspaceName(id, name);
          setWorkspaceName(name);
        }}
        onOpenUserSettings={
          sessionSignedIn && user !== null
            ? () => {
                // The quick modal is gone: the manager's settings entry opens
                // the full settings page (the shell re-renders once the
                // manager closes).
                setManagerOpen(false);
                openSettingsSection("appearance");
              }
            : undefined
        }
        onSignOut={() => void handleSignOut()}
        onClose={enteringFromApp ? () => setManagerOpen(false) : undefined}
      />
    );
  }

  if (phase.name === "connecting" || client === null) {
    return (
      <div className="nt-bootstrap">
        <div className="nt-bootstrap-form" role="status" aria-busy="true">
          <h1 className="nt-bootstrap-title">Notees</h1>
          <p className="nt-bootstrap-subtitle">
            {phase.name === "connecting" ? phase.label : "Starting…"}
          </p>
          {error !== null && <p className="nt-error" role="alert">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className={sidebarOpen ? "nt-app nt-sidebar-open" : "nt-app"}>
      <a className="nt-skip-link" href="#nt-main-content">
        Skip to content
      </a>
      <TopBar
        breadcrumbs={
          selectedPageId !== null ? (
            <Breadcrumbs client={client} nodeId={selectedPageId} onOpenNode={openPage} editable />
          ) : null
        }
        sidebarOpen={sidebarOpen}
        rightPanelOpen={rightPanelOpen}
        canGoBack={navStack.index > 0}
        canGoForward={navStack.index < navStack.entries.length - 1}
        onGoBack={() => window.history.back()}
        onGoForward={() => window.history.forward()}
        calendarOpen={calendarOpen}
        onToggleCalendar={() => setCalendarOpen((open) => !open)}
        calendarButtonRef={calendarButtonRef}
        undoState={undoUi}
        onUndo={() => {
          void client.undo().catch((error: unknown) => {
            console.error("undo failed:", error);
          });
          scheduleUndoRefresh();
        }}
        onRedo={() => {
          void client.redo().catch((error: unknown) => {
            console.error("redo failed:", error);
          });
          scheduleUndoRefresh();
        }}
        onToggleHistory={() => setHistoryOpen((open) => !open)}
        historyButtonRef={historyButtonRef}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        onToggleRightPanel={() => setRightPanelOpen((open) => !open)}
        onNewNode={() => setNewPickerOpen(true)}
        onRequestSearch={() => setPaletteOpen(true)}
        newButtonRef={newButtonRef}
        sectionsLayout={sectionsLayout}
        onToggleLayout={selectedPageId !== null ? () => setSectionsLayout((v) => !v) : undefined}
        focusMode={focusMode}
        onToggleFocusMode={() => setFocusMode(toggleFocusMode())}
        condensedActive={condensedActive}
        onToggleCondensed={
          selectedPageId !== null ? () => setCondensedPref(!condensedActive) : undefined
        }
        workspaceSwitcher={
          offline ? undefined : (
            <WorkspaceSwitcher
              serverUrl={serverUrl}
              credential={token}
              activeWorkspaceId={readStored(STORAGE_KEYS.workspaceId)}
              activeName={workspaceName}
              client={client}
              onSwitch={(id, name) => {
                setSelectedPageId(null);
                void connect(serverUrl, token, id, {
                  isOffline: false,
                  credentialType: sessionSignedIn ? "session" : "apikey",
                  label: name,
                });
              }}
              onManageWorkspaces={() => {
                pushNav("/workspaces", { view: "workspaces" });
                setManagerOpen(true);
              }}
              onRenamed={(id, name) => {
                rememberWorkspaceName(id, name);
                if (id === readStored(STORAGE_KEYS.workspaceId)) setWorkspaceName(name);
              }}
            />
          )
        }
      />
      {newPickerOpen && (
        <NodeSelector
          client={client}
          anchorEl={newButtonRef.current}
          searchMode="classes"
          searchPlaceholder="Search classes…"
          onClose={() => setNewPickerOpen(false)}
          onAdd={(picked) => {
            // Single-pick contract (owner ruling): one class, one page —
            // "create a person", "create a project". Picking creates the
            // untitled page of that class and opens it.
            setNewPickerOpen(false);
            createNodesWithClasses(client, [picked.id], openPage);
          }}
        />
      )}
      {historyOpen && (
        <HistoryMenuPopup
          client={client}
          isOpen
          onClose={() => setHistoryOpen(false)}
          anchorRef={historyButtonRef}
          onOpenNode={(nodeId) => openPage(nodeId)}
        />
      )}
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
        <NodeLinkMenuHost
          client={client}
          openNode={openPage}
          openInSidebar={openInSidebar}
        >
        <NodeHoverPreviewHost client={client} openNode={openPage}>
        {/* The ONE workspace drag session: the host wraps the FloatingEditorHost
            (which wraps the regions), so the main content card, the right
            rail's workspace cards, and the floating editor windows (portals
            keep the React context) all join the same drag — useWorkspaceDnd.ts.
            The rail's card reorder rides the same session: the host reports
            the gesture, the App owns the stack + its device-local order. */}
        <WorkspaceDndHost onRailCardReorder={reorderSidebarCard}>
        <FloatingEditorHost client={client} openNode={openPage}>
        <Sidebar
          client={client}
          user={user}
          offline={offline}
          showSettings={sessionSignedIn && user !== null && !offline}
          onOpenSettings={() => openSettingsSection("appearance")}
          syncStatus={syncStatus}
          onOpenSyncDetails={() => setSyncDetailsOpen(true)}
          onOpenAdminSettings={
            sessionSignedIn && user !== null && !offline && user.isAdmin
              ? () => setAdminSettingsOpen(true)
              : undefined
          }
          selectedPageId={selectedPageId}
          activeNav={activeNav}
          onSelectNav={(key) => {
            // Today is a page, not a hub (owner 2026-10-06 — the sidebar
            // entry before Journal): ensure the chain and open the day page.
            if (key === "today") {
              const live = clientRef.current;
              if (live !== null) {
                void live.ensureDateChain(todayIsoLocal()).then(({ day }) => openPage(day));
              }
              return;
            }
            setSettingsSection(null);
            setSearchOpen(false);
            setActiveNav(key);
            setSelectedPageId(null);
            pushNav(pathForNav(key), { node: null, nav: key });
          }}
          onOpenPage={openPage}
          onSignOut={() => void handleSignOut()}
          onOpenInSidebar={openInSidebar}
        />
        <PageCard
          accent={
            selectedPageId !== null
              ? (() => {
                  const current = client.getNode(selectedPageId);
                  return current === undefined ? null : client.effectiveNodeColor(current);
                })()
              : null
          }
        >
          {selectedPageId !== null ? (
            <NodeView
              client={client}
              nodeId={selectedPageId}
              onOpenNode={openPage}
              onOpenNodeRaw={openPageAt}
              onOpenInSidebar={openInSidebar}
              onDeleted={handleNodeDeleted}
              onPresent={(id) => setPresentingId(id)}
              cornerMenu
              shareTarget={shareTarget}
              sectionsLayout={sectionsLayout}
            />
          ) : searchOpen ? (
            <SearchPage
              client={client}
              onOpenNode={openPage}
              initialQuery={new URLSearchParams(window.location.search).get("q") ?? ""}
            />
          ) : settingsSection !== null && user !== null ? (
            <SettingsPage
              section={settingsSection}
              onNavigate={openSettingsSection}
              serverUrl={serverUrl}
              token={token}
              user={user}
              onSignOut={() => void handleSignOut()}
              syncConnected={syncStatus.status !== "error"}
              onForgetServer={() => handleForgetServer()}
              onConnectServer={(url) => handleConnectServer(url)}
            />
          ) : activeNav === "journal" ? (
            <JournalsView client={client} onOpenPage={openPage} />
          ) : activeNav === "calendar" ? (
            <CalendarView client={client} onOpenPage={openPage} />
          ) : activeNav === "queries" ? (
            <QueriesHub client={client} onOpenNode={openPage} onOpenInSidebar={openInSidebar} />
          ) : activeNav === "graph" ? (
            /* The graph hub renders edge-to-edge in the main content card —
               the canvas is the card's sole content (the whiteboard-surface
               treatment; the card frame itself stays). */
            <div className="nt-graph-surface">
              <GraphView client={client} onNodeClick={openPage} />
            </div>
          ) : activeNav === "trash" ? (
            /* The Trash hub: browse / restore / permanently delete trashed
               subtrees (the data path always existed — this is the v1
               sidebar surface restored for the web). Reached from the
               account popup since 2026-10-19. */
            <TrashHub client={client} onOpenNode={openPage} />
          ) : activeNav === "shares" ? (
            /* The Shares hub (owner 2026-10-19): the v1 SharesUnifiedView's
               Shared-Out tab over the v2 public-link share register —
               reached from the account popup. */
            <SharesHub
              client={client}
              serverUrl={serverUrl}
              credential={token}
              onOpenNode={openPage}
            />
          ) : (
            <HubView client={client} nav={activeNav} onOpenNode={openPage} onOpenInSidebar={openInSidebar} />
          )}
        </PageCard>
        {rightPanelOpen && (
          <aside className="nt-right-card" aria-label="Right sidebar">
            {/* The cards-only rail: the node-relevant widgets
                (graph/TOC/Activity/Comments) relocated into the page chrome's
                context column; this rail hosts workspace cards exclusively —
                the generic frame around NodeView. Fixed-height surfaced panel
                (owner 2026-10-14): it stretches the body height regardless
                of the card count and scrolls internally when the stack
                outgrows it. */}
            {sidebarCards.length > 0 && (
              <div className="nt-right-card__bar">
                <span className="nt-right-card__bar-label">Peeked pages</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSidebarCards([]);
                    setRightPanelOpen(false);
                  }}
                >
                  Clear all
                </Button>
              </div>
            )}
            {sidebarCards.map((cardId) => (
              <NodeCardFrame
                key={cardId}
                client={client}
                nodeId={cardId}
                onOpenNode={openPage}
                onOpenNodeRaw={openPageAt}
                onClose={() => closeSidebarCard(cardId)}
              />
            ))}
          </aside>
        )}
        </FloatingEditorHost>
        </WorkspaceDndHost>
        </NodeHoverPreviewHost>
        </NodeLinkMenuHost>
      </div>
      <CommandPalette
        client={client}
        open={paletteOpen}
        onRequestOpen={() => setPaletteOpen(true)}
        onClose={() => setPaletteOpen(false)}
        onOpenNode={openPage}
        onNewPage={(title) => void handleNewPage(title)}
        onOpenClassCreate={() => setClassCreateOpen(true)}
        onOpenProperty={(schemaId) => setPropertyViewFor(schemaId)}
        currentNodeId={selectedPageId ?? undefined}
        onOpenMerge={storeMode === "in-process" ? () => setMergeOpen(true) : undefined}
        condensedActive={condensedActive}
        onToggleCondensed={
          selectedPageId !== null ? () => setCondensedPref(!condensedActive) : undefined
        }
        onOpenSearch={(query) => openSearchPage(query)}
        onSignOut={() => void handleSignOut()}
        undoState={undoUi}
        onUndo={() => {
          void client.undo().catch((error: unknown) => {
            console.error("undo failed:", error);
          });
          scheduleUndoRefresh();
        }}
        onRedo={() => {
          void client.redo().catch((error: unknown) => {
            console.error("redo failed:", error);
          });
          scheduleUndoRefresh();
        }}
        cacheVersion={pagesVersion}
      />
      {quickAddOpen && (
        <QuickAddModal isOpen={quickAddOpen} onClose={() => setQuickAddOpen(false)} client={client} />
      )}
      {classCreateOpen && (
        <ClassCreateModal
          isOpen
          client={client}
          onClose={() => setClassCreateOpen(false)}
          onCreated={(id) => openPage(id)}
        />
      )}
      {mergeOpen && selectedPageId !== null && client instanceof WorkspaceClient && (
        <MergeNodesModal
          isOpen
          client={client}
          sourceId={selectedPageId}
          onClose={() => setMergeOpen(false)}
          onMerged={(targetId) => {
            setMergeOpen(false);
            openPage(targetId);
          }}
        />
      )}
      {propertyViewFor !== null && (
        <PropertyView
          client={client}
          propertySchemaId={propertyViewFor}
          onClose={() => setPropertyViewFor(null)}
          onOpenPage={(id) => {
            setPropertyViewFor(null);
            openPage(id);
          }}
        />
      )}
      {/* The mobile quick-create FAB: hosts its own
          QuickAddModal; CSS surfaces the button only at narrow widths. */}
      <QuickCreateFab client={client} />
      {presentingId !== null && (
        <DeckView
          client={client}
          pageId={presentingId}
          onOpenNode={openPage}
          onClose={() => setPresentingId(null)}
        />
      )}
      {storeMode === "in-process" && <InProcessStoreBanner reason={storeReason} />}
      {client !== null && (
        <SyncDetailsModal
          client={client}
          snapshot={syncStatus}
          isOpen={syncDetailsOpen}
          onClose={() => setSyncDetailsOpen(false)}
        />
      )}
      {client !== null && adminSettingsOpen && (
        /* The account popup's admin entry (admin users only): the active
           workspace's settings, opened on the plugins tab — the
           admin-gated surface (the server enforces admin on the routes). */
        <WorkspaceSettingsModal
          isOpen
          onClose={() => setAdminSettingsOpen(false)}
          serverUrl={serverUrl}
          credential={token}
          workspaceId={readStored(STORAGE_KEYS.workspaceId)}
          workspaceName={workspaceName}
          workspaceRole={
            rememberedWorkspaceList().find((ws) => ws.id === readStored(STORAGE_KEYS.workspaceId))?.role ?? "owner"
          }
          initialTab="plugins"
          client={client}
          onRenamed={(name) => {
            const id = readStored(STORAGE_KEYS.workspaceId);
            rememberWorkspaceName(id, name);
            setWorkspaceName(name);
          }}
        />
      )}
      <BackendUnavailableOverlay syncStatus={syncStatus} />
      <NotificationToaster />
    </div>
  );
}
