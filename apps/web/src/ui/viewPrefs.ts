/**
 * View preferences — the durable, device-local persistence seam for view
 * modes and card cover layouts: the session-only ruling reverses
 * INTO device settings — never the op log; device state is never an op).
 *
 * Three surfaces persist, each keyed honestly:
 *   - a page's child-blocks triad      → `viewMode.nodeBlocks.<pageId>`
 *   - a hub's collection mode          → `viewMode.hub.<hubKey>`
 *   - a class's classed-nodes mode     → `viewMode.classMembers.<classId>`
 *   - the card cover layout (one       → `cards.coverLayout` (one global
 *     global preference per device)      preference per device)
 *
 * Values are validated against the modes the surface currently offers, so a
 * stale or hand-edited localStorage entry can never select a mode the
 * switcher doesn't have (the read falls back to the surface default). The
 * retired kanban mode merged into cards — the board is cards + property
 * groupBy — so a persisted "kanban" reads back as "cards".
 */

import { readDeviceSetting, useDeviceSetting, writeDeviceSetting } from "./components/modals/deviceSettings.js";
import type { CardLayout, ViewMode } from "./views/types.js";

const VIEW_MODES: readonly ViewMode[] = ["outline", "prose", "cards", "table"];
const CARD_LAYOUTS: readonly CardLayout[] = ["no-cover", "cover-top", "cover-left", "cover-right"];

function sanitizeViewMode(value: unknown, allowed: readonly ViewMode[]): ViewMode | null {
  if (typeof value !== "string") return null;
  // The retired kanban mode is cards now (its board renders when the
  // surface groups by a select property) — preserve the persisted choice.
  const mode = value === "kanban" ? "cards" : value;
  return (VIEW_MODES as readonly string[]).includes(mode)
    ? (allowed as readonly string[]).includes(mode)
      ? (mode as ViewMode)
      : null
    : null;
}

/** The persisted mode for a surface, or null when unset/invalid/stale. */
export function readViewModePref(
  persistKey: string,
  allowed: readonly ViewMode[],
): ViewMode | null {
  return sanitizeViewMode(readDeviceSetting<unknown>(`viewMode.${persistKey}`, null), allowed);
}

export function writeViewModePref(persistKey: string, mode: ViewMode): void {
  writeDeviceSetting(`viewMode.${persistKey}`, mode);
}

/**
 * useViewModePreference — like the session `useState<ViewMode>` it replaces,
 * but the choice survives reloads under `viewMode.<persistKey>`. Unset or
 * invalid values fall back to `defaultMode`; a change outside this hook
 * (another tab) re-syncs through the device-setting events.
 */
export function useViewModePreference(
  persistKey: string,
  defaultMode: ViewMode,
  allowed: readonly ViewMode[],
): [ViewMode, (mode: ViewMode) => void] {
  const [stored, setStored] = useDeviceSetting<unknown>(`viewMode.${persistKey}`, null);
  const mode = sanitizeViewMode(stored, allowed) ?? defaultMode;
  return [mode, (next) => setStored(next)];
}

/** The device's card cover layout (null when unset/invalid). */
export function readCardLayoutPref(): CardLayout | null {
  const value = readDeviceSetting<unknown>("cards.coverLayout", null);
  return typeof value === "string" && (CARD_LAYOUTS as readonly string[]).includes(value)
    ? (value as CardLayout)
    : null;
}

export function writeCardLayoutPref(layout: CardLayout): void {
  writeDeviceSetting("cards.coverLayout", layout);
}

/**
 * useCardLayoutPreference — the cover-layout toggle's persisted state.
 * `fallback` keeps today's default ("no-cover") explicit at the call sites.
 */
export function useCardLayoutPreference(fallback: CardLayout = "no-cover"): [CardLayout, (layout: CardLayout) => void] {
  const [stored, setStored] = useDeviceSetting<unknown>("cards.coverLayout", null);
  const layout =
    typeof stored === "string" && (CARD_LAYOUTS as readonly string[]).includes(stored)
      ? (stored as CardLayout)
      : fallback;
  return [layout, (next) => setStored(next)];
}

// --- Unlinked-reference ignore list (L4) ---------------------------------------

const ignoredCache = new Map<string, string[]>();

function ignoredKey(pageId: string): string {
  return `unlinkedRefsIgnored.${pageId}`;
}

/** Device-local ignored source ids for a page's unlinked-references section. */
export function readIgnoredUnlinkedRefs(pageId: string): string[] {
  let cached = ignoredCache.get(pageId);
  if (cached === undefined) {
    const raw = readDeviceSetting<unknown>(ignoredKey(pageId), []);
    cached = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
    ignoredCache.set(pageId, cached);
  }
  return cached;
}

/** Ignore (or un-ignore) one source for one page — device state, never an op. */
export function writeIgnoredUnlinkedRef(pageId: string, sourceId: string, ignored: boolean): void {
  const current = new Set(readIgnoredUnlinkedRefs(pageId));
  if (ignored) current.add(sourceId);
  else current.delete(sourceId);
  const next = [...current];
  ignoredCache.set(pageId, next);
  writeDeviceSetting(ignoredKey(pageId), next);
}

/**
 * useIgnoredUnlinkedRefs — the section's live view of the ignore list: filter
 * with `readIgnoredUnlinkedRefs`, mutate with `writeIgnoredUnlinkedRef`; both
 * re-render this hook's consumers through the device-setting events.
 */
export function useIgnoredUnlinkedRefs(pageId: string): string[] {
  const [raw] = useDeviceSetting<unknown>(ignoredKey(pageId), []);
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
}

// --- Cover collapse (L2) --------------------------------------------------------

/** Per-page banner collapse flag (`pageCoverCollapsed.<pageId>`). */
export function useCoverCollapsed(pageId: string): [boolean, (collapsed: boolean) => void] {
  const [raw, setRaw] = useDeviceSetting<boolean>(`pageCoverCollapsed.${pageId}`, false);
  return [raw === true, setRaw];
}

/** Per-page banner collapse flag (`pageBannerCollapsed.<pageId>`) — the banner
 * starts collapsed on every page until the device expands it. */
export function useBannerCollapsed(pageId: string): [boolean, (collapsed: boolean) => void] {
  const [raw, setRaw] = useDeviceSetting<boolean>(`pageBannerCollapsed.${pageId}`, true);
  return [raw !== false, setRaw];
}
