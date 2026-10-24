/**
 * routing — the URL ↔ view mapping seam (framework-free).
 *
 * Hub routes (`/journal`, `/inbox`, …), the settings-section path mapping,
 * the calendar's zoom/day subroutes (`/calendar/<zoom>/<iso>`), the in-app
 * Back/Forward stack tracker, and the ONE tab-title rule (law 9 — view
 * surfaces own their tab title). App owns the state; this module owns the
 * pure path/stack/title logic. Exported pieces are unit-tested by the
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
import { formatDateName } from "../dateDisplay.js";
import { weekDaysOfIso } from "../../features/calendar/calendarViewUtils.js";

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
  if (NAV_PATHS[key] !== undefined) return NAV_PATHS[key];
  // The calendar owns its subroutes (`/calendar/<zoom>/<day>` — the zoom and
  // the day ride the calendarRoute seam, not the hub key): any /calendar/*
  // path still boots the calendar hub.
  if ((key.split("/")[0] ?? "") === "calendar") return "calendar";
  return null;
}

export function pathForNav(nav: NavKey): string {
  return `/${nav}`;
}

/**
 * The calendar's zoom ladder (owner 2026-10-24 — the calendar becomes
 * URL-addressable): the view's type lives here, beside the path mapping, so
 * the parse/build helpers and the tab-title register share one definition.
 */
export type CalendarZoom = "day" | "week" | "month" | "year" | "agenda";

const CALENDAR_ZOOM_SET: ReadonlySet<string> = new Set([
  "day",
  "week",
  "month",
  "year",
  "agenda",
]);

export function isCalendarZoom(value: string): value is CalendarZoom {
  return CALENDAR_ZOOM_SET.has(value);
}

/** A real local ISO day (yyyy-mm-dd that actually exists on the calendar). */
export function isIsoDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month0 = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month0, day);
  return (
    date.getFullYear() === year && date.getMonth() === month0 && date.getDate() === day
  );
}

/**
 * The calendar surface's parsed route: the URL's zoom + selected day. A null
 * `zoom` is the bare-calendar default (the `calendarZoom` device setting
 * fills it); a null `iso` is the today default. The whole result is null
 * when the path is not a calendar route at all.
 */
export interface CalendarRoute {
  zoom: CalendarZoom | null;
  iso: string | null;
}

/**
 * Parse `/calendar`, `/calendar/<zoom>`, `/calendar/<zoom>/<iso>` into the
 * route state. Only valid zooms ride the URL — anything else parses as the
 * bare default (`{ zoom: null, iso: null }`, still a calendar route); a
 * malformed/absent iso is ignored (null = today). Returns null for
 * non-calendar paths.
 */
export function calendarRouteFromPath(pathname: string): CalendarRoute | null {
  const segments = pathname.split("/").filter((segment) => segment !== "");
  if (segments.length === 0 || segments[0]!.toLowerCase() !== "calendar") return null;
  // Valid zooms only: an invalid zoom segment falls back to the bare default
  // wholesale (the iso is the ZOOM's segment — it never rides alone).
  if (segments.length < 2 || !isCalendarZoom(segments[1]!)) return { zoom: null, iso: null };
  const iso = segments.length >= 3 && isIsoDay(segments[2]!) ? segments[2]! : null;
  return { zoom: segments[1]! as CalendarZoom, iso };
}

/** Build the calendar path: `/calendar/<zoom>` or `/calendar/<zoom>/<iso>`. */
export function pathForCalendar(zoom: CalendarZoom, iso: string | null = null): string {
  return iso !== null ? `/calendar/${zoom}/${iso}` : `/calendar/${zoom}`;
}

/**
 * The calendar tab-title's period register (law 9 — the calendar names the
 * surface + the visible period): day = the formatted day (the user's
 * date-format setting, like the view's own date line); week = the week's
 * date range ("Week of 19 Oct – 25 Oct"); month/agenda = the long month +
 * year of the visible period; year = the year. The App's title writer
 * appends " — Calendar".
 */
export function calendarPeriodTitle(
  zoom: CalendarZoom,
  period: { iso: string; year: number; month0: number; firstDayOfWeek: number },
): string {
  switch (zoom) {
    case "day":
      return formatDateName(period.iso.replace(/-/g, "")) ?? period.iso;
    case "week": {
      const days = weekDaysOfIso(period.iso, period.firstDayOfWeek);
      const fmt = (iso: string): string => {
        const [y, m, d] = iso.split("-").map(Number);
        return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, {
          day: "numeric",
          month: "short",
        });
      };
      return `Week of ${fmt(days[0]!)} – ${fmt(days[6]!)}`;
    }
    case "year":
      return String(period.year);
    case "month":
    case "agenda":
      return new Date(period.year, period.month0, 1).toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      });
  }
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
  /** The calendar's parsed route (null off the surface); omitted = no-op. */
  setCalendarRoute?: ((route: CalendarRoute | null) => void) | undefined;
  /** The back/forward tracker's seam: fires with the landed URL (every branch). */
  onNavigated?: ((url: string) => void) | undefined;
}): () => void {
  return () => {
    const path = window.location.pathname;
    opts.onNavigated?.(path + window.location.search);
    opts.setSettingsSection(settingsSectionFromPath(path));
    opts.setCalendarRoute?.(calendarRouteFromPath(path));
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
  /**
   * The calendar view's own title (e.g. "October 2026 — Calendar"), set while
   * the surface is mounted; null/absent cedes to the hub register.
   */
  calendarTitle?: string | null;
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
  if (opts.activeNav === "calendar" && opts.calendarTitle) return opts.calendarTitle;
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
