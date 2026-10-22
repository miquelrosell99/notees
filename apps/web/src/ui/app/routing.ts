/**
 * routing — the URL ↔ view mapping seam (framework-free).
 *
 * Hub routes (`/journal`, `/inbox`, …), the settings-section path mapping,
 * the in-app Back/Forward stack tracker, and the ONE tab-title rule (law 9 —
 * view surfaces own their tab title). App owns the state; this module owns
 * the pure path/stack/title logic. Exported pieces are unit-tested by the
 * routing/title/nav-stack suites.
 */

import { NAV_ENTRIES, type NavKey } from "./Sidebar.js";
import {
  SETTINGS_SECTIONS,
  pathForSettingsSection,
  settingsSectionFromPath,
  type SettingsSection,
} from "../../features/settings/SettingsPage.js";
import { readDeviceSetting } from "../../features/settings/deviceSettings.js";

/**
 * Hub routes: each NAVIGATION entry has a URL (`/journal`, `/inbox`, …) so a
 * reload or deep link boots straight into that hub. `/journals` is accepted
 * as a friendly alias.
 */
const NAV_PATHS: Record<string, NavKey> = {
  journal: "journal",
  journals: "journal",
  calendar: "calendar",
  inbox: "inbox",
  pages: "pages",
  classes: "classes",
  whiteboards: "whiteboards",
  tasks: "tasks",
  assets: "assets",
  queries: "queries",
  graph: "graph",
  trash: "trash",
  archived: "archived",
  shares: "shares",
};

export function navFromPath(pathname: string): NavKey | null {
  const key = pathname.replace(/^\//, "").replace(/\/$/, "").toLowerCase();
  return NAV_PATHS[key] ?? null;
}

export function pathForNav(nav: NavKey): string {
  return `/${nav}`;
}

/** Push a settings-section change onto the history stack (the URL seam the
 *  popstate handler maps back); exported for the routing tests. */
export function pushSettingsSection(section: SettingsSection): void {
  window.history.pushState({ settings: section }, "", pathForSettingsSection(section));
}

/**
 * Back/forward navigation drives the selection / views / settings section.
 * Exported for the routing tests, mirroring the other handler factories.
 */
export function popStateNavHandler(opts: {
  openManager: () => void;
  closeManager: () => void;
  setNav: (nav: NavKey) => void;
  setNode: (id: string | null) => void;
  setSettingsSection: (section: SettingsSection | null) => void;
  /** The /search route flag; omitted by older callers (a no-op). */
  setSearch?: ((open: boolean) => void) | undefined;
  /** The back/forward tracker's seam: fires with the landed URL (every branch). */
  onNavigated?: ((url: string) => void) | undefined;
}): () => void {
  return () => {
    const path = window.location.pathname;
    opts.onNavigated?.(path + window.location.search);
    opts.setSettingsSection(settingsSectionFromPath(path));
    if (path === "/workspaces") {
      opts.openManager();
      return;
    }
    if (path === "/login" || path === "/auth") {
      opts.closeManager();
      opts.setNode(null);
      return;
    }
    if (path === "/search") {
      // The full-page search route: the flag carries it, like a settings
      // section (the query itself rides the ?q= param, read on mount).
      opts.closeManager();
      opts.setSearch?.(true);
      opts.setNode(null);
      return;
    }
    const nav = navFromPath(path);
    if (nav !== null) {
      opts.closeManager();
      opts.setSearch?.(false);
      opts.setNav(nav);
      opts.setNode(null);
      return;
    }
    const match = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(path);
    opts.closeManager();
    opts.setSearch?.(false);
    opts.setNode(match !== null ? match[1]! : null);
  };
}

/**
 * The in-app navigation stack behind the top bar's Back/Forward arrows.
 * Every in-app navigation is a pushState with a distinct URL, so the App
 * tracks its OWN stack (entries + cursor) rather than asking the browser
 * (the browser stack reaches beyond the app — a Back that leaves Notees is
 * never what the arrows mean). Pure; exported for the routing tests.
 */
export interface NavStack {
  entries: string[];
  index: number;
}

/** The URL identity of a navigation: path + query (e.g. /search?q=x). */
export function currentNavUrl(loc: Pick<Location, "pathname" | "search"> = window.location): string {
  return loc.pathname + loc.search;
}

/** A push: truncate any forward tail, append, move the cursor. */
export function recordNavPush(stack: NavStack, url: string): NavStack {
  return { entries: [...stack.entries.slice(0, stack.index + 1), url], index: stack.index + 1 };
}

/**
 * A popstate landing: step the cursor toward the matching neighbor, or reset
 * to a single-entry stack when the URL is foreign (deep link typed by hand,
 * boot) — the stack only ever describes navigations the app recorded.
 */
export function recordNavPop(stack: NavStack, url: string): NavStack {
  if (stack.entries[stack.index - 1] === url) return { ...stack, index: stack.index - 1 };
  if (stack.entries[stack.index + 1] === url) return { ...stack, index: stack.index + 1 };
  if (stack.entries[stack.index] === url) return stack;
  return { entries: [url], index: 0 };
}

/**
 * The ONE tab-title rule (law 9 — view surfaces own their tab title): names
 * the open surface, mirroring the PageCard render precedence — the settings
 * section first, then the open node, then the full-page search, then the
 * active nav hub ("Trash - Notees", "Graph - Notees", …). A view without a
 * selection no longer leaves a stale title. The App's title effect is the
 * only writer; exported for the title tests, mirroring the other handler
 * factories.
 */
export function tabTitle(opts: {
  /** False while signed out / booting — the bare app name. */
  clientPresent: boolean;
  selectedPageId: string | null;
  settingsSection: SettingsSection | null;
  searchOpen: boolean;
  activeNav: NavKey;
  /** The resolved display name of the open node ("" when unknown). */
  nodeName: string;
}): string {
  if (opts.settingsSection !== null) {
    const label =
      SETTINGS_SECTIONS.find((section) => section.id === opts.settingsSection)?.label ?? "Settings";
    return `${label} - Notees`;
  }
  if (!opts.clientPresent) return "Notees";
  if (opts.selectedPageId !== null) {
    return opts.nodeName !== "" ? `${opts.nodeName} - Notees` : "Notees";
  }
  if (opts.searchOpen) return "Search - Notees";
  const entry = NAV_ENTRIES.find((item) => item.key === opts.activeNav);
  return entry !== undefined ? `${entry.label} - Notees` : "Notees";
}

/**
 * Initial view: a hub URL in the address bar wins; otherwise the journal
 * feed is the default ("open in journal view") with the device-local
 * "default view" preference overriding it (legacy choices that have no hub
 * in this build land on Pages).
 */
export function initialNav(): NavKey {
  const fromPath = navFromPath(window.location.pathname);
  if (fromPath !== null) return fromPath;
  const view = readDeviceSetting<string | null>("defaultView", null);
  if (view === null) return "journal";
  if (view === "journal" || view === "today") return "journal";
  return "pages";
}
