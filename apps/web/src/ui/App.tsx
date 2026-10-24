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

import { useEffect, useRef, useState } from "react";

import { WorkspaceClient, type ClientNode, type SyncStatusSnapshot } from "@/core/workspace-client/index.js";
import { EMPTY_UNDO_STATE } from "@/core/undo-journal.js";
import {
  rememberWorkspaceName,
  rememberedWorkspaceList,
} from "@/core/workspace-registry.js";
import { logout } from "@/core/auth-api.js";

import { nodeDisplayName } from "./dateDisplay.js";
import { parentlessBlockResolverOf } from "./renderStateLabel.js";
import type { ShareTarget } from "../features/node-menu/NodeMenuButton.js";
import { rendersAsInlineBlock } from "@notees/domain";
import { type NavKey } from "./app/Sidebar.js";
import { recordRecent } from "../features/sidebar/recentPages.js";
import { resolveAliasOpen } from "../features/metadata/aliasProperty.js";
import { WorkspacesView } from "../features/workspaces/WorkspacesView.js";
import {
  SettingsPage,
  pathForSettingsSection,
  settingsSectionFromPath,
  type SettingsSection,
} from "../features/settings/SettingsPage.js";
import { applyAppearance, readDeviceSetting, toggleFocusMode, useDeviceSetting } from "../features/settings/deviceSettings.js";
import { useCondensedPreference } from "./viewPrefs.js";
import {
  AppBody,
  AppModals,
  AppOverlays,
  AppTopBar,
  BootForm,
  HubView,
  STORAGE_KEYS,
  clearStored,
  currentNavUrl,
  initialNav,
  initialServerUrl,
  calendarRouteFromPath,
  pathForCalendar,
  popStateNavHandler,
  pushSettingsSection,
  readStored,
  recordNavPop,
  recordNavPush,
  tabTitle,
  type CalendarRoute,
  type CalendarZoom,
  type CredentialType,
  type NavStack,
  useBootFlow,
  useGlobalGestures,
  useRailCards,
  useUndoChrome,
  useWorkspaceConnection,
} from "./app/index.js";
import "./app.css";

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
  const conn = useWorkspaceConnection();
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
  } = conn;
  /** The sync indicator's details modal (resync + conflicts). */
  const [syncDetailsOpen, setSyncDetailsOpen] = useState(false);
  /** The account popup's admin entry: the active workspace's settings (plugins tab). */
  const [adminSettingsOpen, setAdminSettingsOpen] = useState(false);
  /** Manage Workspaces view, opened from the workspace switcher popup. */
  const [managerOpen, setManagerOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    // Default: open on desktop, closed on narrow screens. jsdom lacks
    // matchMedia — default open there.
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
    // 801px is a deliberate non-register threshold (the register runs
    // 480/768/1024/1440) — it gates the sidebar's open-by-default state, and
    // behavior preservation beats breakpoint purity here.
    return window.matchMedia("(width >= 801px)").matches;
  });
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  /**
   * The session-only page-layout toggle (owner 2026-10-12): false renders
   * the panelled default (the properties sidebar rides the first column);
   * true renders the main content as in-flow sections (the compact layout).
   * Component state — never persisted; the app top bar's layout button
   * flips it and the icon names the current mode.
   */
  const [sectionsLayout, setSectionsLayout] = useState(false);
  const rail = useRailCards({ client, clientRef, setRightPanelOpen });
  const { sidebarCards, setSidebarCards, openInSidebar, closeSidebarCard, reorderSidebarCard } = rail;
  /**
   * Post-delete navigation: a deleted page/class lands on its parent page
   * when one exists, otherwise on the workspace default view (today's page /
   * journal / pages hub). Inline blocks vanish in place — no navigation.
   */
  function handleNodeDeleted(node: ClientNode): void {
    const live = clientRef.current;
    if (
      live !== null &&
      live !== undefined &&
      rendersAsInlineBlock(node, live.getNode(node.parentId ?? ""), parentlessBlockResolverOf(live))
    )
      return;
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
  const { undoUi, setUndoUi, undoUiRef, scheduleUndoRefresh, runUndo, runRedo } =
    useUndoChrome(clientRef);
  /** Top-bar calendar popup (the popup needs the client, so it renders here). */
  const [calendarOpen, setCalendarOpen] = useState(false);
  const calendarButtonRef = useRef<HTMLButtonElement | null>(null);
  /** The browsable history popup over the undo journal. */
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyButtonRef = useRef<HTMLButtonElement | null>(null);
  const [firstDayOfWeek] = useDeviceSetting("firstDayOfWeek", 1);
  /** Focus mode (#12) — device-local; the data attribute drives the shell dim. */
  const [focusMode, setFocusMode] = useDeviceSetting("focusMode", false);
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
   * The calendar surface's parsed route (owner 2026-10-24 — the calendar is
   * URL-addressable): the /calendar/<zoom>/<iso> in the address bar, or null
   * when the current URL is not a calendar route. A null zoom inside the
   * route is the bare path (the `calendarZoom` device setting fills it).
   * Boot deep links and every popstate landing set it; the view's
   * push/replace callbacks keep it in step; every other navigation clears
   * it (the sidebar's calendar row re-lands on the bare default).
   */
  const [calendarRoute, setCalendarRoute] = useState<CalendarRoute | null>(() =>
    calendarRouteFromPath(window.location.pathname),
  );
  /**
   * The calendar view's tab-title contribution while mounted ("October 2026
   * — Calendar"); null cedes to the hub register (law 9).
   */
  const [calendarTitle, setCalendarTitle] = useState<string | null>(null);
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
   * The calendar view's URL seam (owner 2026-10-24): a zoom change PUSHES a
   * new history entry; a selected-day change REPLACES the current one (day
   * picking must not spam history) — the nav stack's current slot follows
   * the replaced URL so back/forward stays consistent.
   */
  function navigateCalendar(next: { zoom: CalendarZoom; iso: string }, mode: "push" | "replace"): void {
    const url = pathForCalendar(next.zoom, next.iso);
    if (mode === "push") {
      pushNav(url, { nav: "calendar", calendar: next });
    } else {
      window.history.replaceState({ nav: "calendar", calendar: next }, "", url);
      setNavStack((stack) => ({
        ...stack,
        entries: stack.entries.map((entry, i) => (i === stack.index ? url : entry)),
      }));
    }
    setCalendarRoute(next);
  }

  const boot = useBootFlow(conn, pushNav);
  const {
    serverUrl,
    setServerUrl,
    user,
    setUser,
    token,
    setToken,
    authTab,
    signupEnabled,
    apiKeyInput,
    workspaces,
    hint,
    setHint,
    serverSuggestion,
    setServerSuggestion,
    connectTo,
    handleWorkOffline,
  } = boot;
  /**
   * Shares: the coordinates the Share… surface needs. Absent in
   * offline mode (there is no server to mint against) — the menu item and
   * modal hide themselves without it.
   */
  const shareTarget: ShareTarget | undefined =
    !offline && serverUrl.trim() !== "" && token !== ""
      ? { serverUrl, credential: token }
      : undefined;
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
  // surfaces (hubs and the full-page search); the calendar hands up its own
  // period title while mounted (it owns its URL AND its tab title).
  useEffect(() => {
    document.title = tabTitle({
      clientPresent: client !== null,
      selectedPageId,
      settingsSection,
      searchOpen,
      activeNav,
      calendarTitle,
      nodeName:
        client !== null && selectedPageId !== null
          ? (() => {
              const node = client.getNode(selectedPageId);
              return node !== undefined
                ? nodeDisplayName(node, (classId) => client.getDisplayName(classId))
                : "";
            })()
          : "",
    });
  }, [client, selectedPageId, pagesVersion, settingsSection, searchOpen, activeNav, calendarTitle]);
  const [quickAddOpen, setQuickAddOpen] = useState(false);

  useGlobalGestures({
    sidebarOpen,
    setSidebarOpen,
    clientRef,
    openPage,
    openSettingsSection,
    openSearchPage,
    setQuickAddOpen,
    setPresentingId,
    selectedPageIdRef,
    undoUiRef,
    scheduleUndoRefresh,
    setHistoryOpen,
    focusMode,
    setFocusMode,
  });

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
    setCalendarRoute(null);
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
    setCalendarRoute(null);
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
    setCalendarRoute(null);
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
      setCalendarRoute(null);
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
      setCalendarRoute,
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

  if (
    phase.name === "server" ||
    phase.name === "setup" ||
    phase.name === "login" ||
    phase.name === "signup"
  ) {
    return <BootForm phase={phase} error={error} setError={setError} setPhase={setPhase} boot={boot} />;
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
      <AppTopBar
        client={client}
        selectedPageId={selectedPageId}
        openPage={openPage}
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
        rightPanelOpen={rightPanelOpen}
        setRightPanelOpen={setRightPanelOpen}
        canGoBack={navStack.index > 0}
        canGoForward={navStack.index < navStack.entries.length - 1}
        calendarOpen={calendarOpen}
        setCalendarOpen={setCalendarOpen}
        calendarButtonRef={calendarButtonRef}
        firstDayOfWeek={firstDayOfWeek}
        undoUi={undoUi}
        runUndo={runUndo}
        runRedo={runRedo}
        historyOpen={historyOpen}
        setHistoryOpen={setHistoryOpen}
        historyButtonRef={historyButtonRef}
        newPickerOpen={newPickerOpen}
        setNewPickerOpen={setNewPickerOpen}
        newButtonRef={newButtonRef}
        setPaletteOpen={setPaletteOpen}
        sectionsLayout={sectionsLayout}
        setSectionsLayout={setSectionsLayout}
        focusMode={focusMode}
        setFocusMode={setFocusMode}
        toggleFocusMode={toggleFocusMode}
        condensedActive={condensedActive}
        setCondensedPref={setCondensedPref}
        offline={offline}
        serverUrl={serverUrl}
        token={token}
        workspaceName={workspaceName}
        sessionSignedIn={sessionSignedIn}
        connect={connect}
        setSelectedPageId={setSelectedPageId}
        pushNav={pushNav}
        setManagerOpen={setManagerOpen}
        setWorkspaceName={setWorkspaceName}
      />
      <AppBody
        client={client}
        clientRef={clientRef}
        user={user}
        offline={offline}
        sessionSignedIn={sessionSignedIn}
        syncStatus={syncStatus}
        setSyncDetailsOpen={setSyncDetailsOpen}
        setAdminSettingsOpen={setAdminSettingsOpen}
        selectedPageId={selectedPageId}
        activeNav={activeNav}
        focusMode={focusMode}
        setActiveNav={setActiveNav}
        setSettingsSection={setSettingsSection}
        setSearchOpen={setSearchOpen}
        setSelectedPageId={setSelectedPageId}
        pushNav={pushNav}
        openPage={openPage}
        openPageAt={openPageAt}
        openInSidebar={openInSidebar}
        openSettingsSection={openSettingsSection}
        handleNodeDeleted={handleNodeDeleted}
        handleSignOut={handleSignOut}
        handleForgetServer={handleForgetServer}
        handleConnectServer={handleConnectServer}
        searchOpen={searchOpen}
        settingsSection={settingsSection}
        serverUrl={serverUrl}
        token={token}
        shareTarget={shareTarget}
        sectionsLayout={sectionsLayout}
        setPresentingId={setPresentingId}
        reorderSidebarCard={reorderSidebarCard}
        rightPanelOpen={rightPanelOpen}
        setRightPanelOpen={setRightPanelOpen}
        sidebarCards={sidebarCards}
        setSidebarCards={setSidebarCards}
        closeSidebarCard={closeSidebarCard}
        calendarRoute={calendarRoute}
        onCalendarRouteChange={navigateCalendar}
        onCalendarTitle={setCalendarTitle}
        resetCalendarRoute={() => setCalendarRoute(null)}
      />
      <AppModals
        client={client}
        paletteOpen={paletteOpen}
        setPaletteOpen={setPaletteOpen}
        openPage={openPage}
        handleNewPage={handleNewPage}
        classCreateOpen={classCreateOpen}
        setClassCreateOpen={setClassCreateOpen}
        propertyViewFor={propertyViewFor}
        setPropertyViewFor={setPropertyViewFor}
        selectedPageId={selectedPageId}
        storeMode={storeMode}
        mergeOpen={mergeOpen}
        setMergeOpen={setMergeOpen}
        condensedActive={condensedActive}
        setCondensedPref={setCondensedPref}
        openSearchPage={openSearchPage}
        handleSignOut={handleSignOut}
        undoUi={undoUi}
        runUndo={runUndo}
        runRedo={runRedo}
        pagesVersion={pagesVersion}
        quickAddOpen={quickAddOpen}
        setQuickAddOpen={setQuickAddOpen}
        presentingId={presentingId}
        setPresentingId={setPresentingId}
        addSourceServerUrl={shareTarget?.serverUrl ?? null}
        addSourceCredential={shareTarget?.credential ?? ""}
      />
      <AppOverlays
        client={client}
        storeMode={storeMode}
        storeReason={storeReason}
        syncStatus={syncStatus}
        syncDetailsOpen={syncDetailsOpen}
        setSyncDetailsOpen={setSyncDetailsOpen}
        adminSettingsOpen={adminSettingsOpen}
        setAdminSettingsOpen={setAdminSettingsOpen}
        serverUrl={serverUrl}
        token={token}
        workspaceName={workspaceName}
        setWorkspaceName={setWorkspaceName}
      />
    </div>
  );
}
