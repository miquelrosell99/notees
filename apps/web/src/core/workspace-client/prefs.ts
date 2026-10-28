/**
 * Per-user UI prefs (favorites/recents — server-side UI state).
 *
 * favorites/recents are UI preferences, so they live
 * in the sync server's per-user prefs store, NOT the operation log ("device
 * state is never an op" stands). This module holds the device-local cache
 * (`notees.favorites` / `notees.recents` lists, `notees.prefs.*` scalars)
 * the client reads/writes as the honest offline fallback, plus the pure
 * list-merge helpers the UI shares.
 * The WorkspaceClient's getPrefs/patchPrefs speak REST over these.
 */

// --- per-user UI prefs (favorites/recents — server-side UI state) ----
//
// favorites/recents are UI preferences,
// so they live in the sync server's per-user prefs store, NOT the operation
// log ("device state is never an op" stands). The client speaks REST
// (getPrefs/patchPrefs below) with a device-local cache (`notees.favorites` /
// `notees.recents`, the pre-existing keys) as the honest offline fallback:
// reads return the cached copy, writes update it immediately and sync when a
// server answers.

export interface UserPrefs {
  /** Ordered starred node ids. */
  favorites: string[];
  /** Most-recent-first node ids. */
  recents: string[];
  /** The memorization-cards scheduler ("sm2" | "fsrs", default "fsrs"). */
  cardsAlgorithm: CardsAlgorithm;
}

/** The spaced-repetition scheduler for the memorization-cards surface. */
export type CardsAlgorithm = "sm2" | "fsrs";

/** The algorithm when the prefs store never carried one. */
export const DEFAULT_CARDS_ALGORITHM: CardsAlgorithm = "fsrs";

/** "server" — the prefs store answered; "local" — the device cache did. */
export type UserPrefsSource = "server" | "local";

/** Merge patch: each present list replaces its column wholesale. */
export interface PrefsPatch {
  favorites?: string[];
  recents?: string[];
  cardsAlgorithm?: CardsAlgorithm;
}

/** The server's recents cap (favorites cap 500 — a UI never gets near it). */
export const MAX_SYNCED_RECENTS = 50;

/** Device-local cache keys — shared with the sidebar/palette legacy readers. */
const PREFS_LOCAL_KEYS = { favorites: "notees.favorites", recents: "notees.recents" } as const;

/** Device-local scalar keys — the prefs channel's non-list values. */
const PREFS_SCALAR_KEYS = { cardsAlgorithm: "notees.prefs.cardsAlgorithm" } as const;

/**
 * Memory backing for realms without localStorage (the store worker): the
 * fallback cache survives the session, honestly not across worker restarts.
 */
const prefsMemoryCache = new Map<string, string[]>();

/** Read one device-local prefs list (`notees.favorites` / `notees.recents`). */
export function readDevicePrefList(key: keyof typeof PREFS_LOCAL_KEYS): string[] {
  // localStorage existing means it is authoritative — an absent key IS an
  // empty list. The memory backing serves only realms without localStorage
  // (the store worker), never as a shadow of an empty store.
  if (typeof localStorage !== "undefined") {
    try {
      const raw = localStorage.getItem(PREFS_LOCAL_KEYS[key]);
      if (raw === null) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === "string")
        : [];
    } catch {
      // Fall through to the memory copy.
    }
  }
  return prefsMemoryCache.get(key) ?? [];
}

/** Write one device-local prefs list (localStorage + memory backing). */
export function writeDevicePrefList(key: keyof typeof PREFS_LOCAL_KEYS, list: string[]): void {
  prefsMemoryCache.set(key, list);
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(PREFS_LOCAL_KEYS[key], JSON.stringify(list));
    }
  } catch {
    // Storage unavailable; the memory copy keeps the session consistent.
  }
}

/** Read one device-local prefs scalar; a missing/garbled key is the default. */
export function readDevicePrefScalar(key: keyof typeof PREFS_SCALAR_KEYS): CardsAlgorithm {
  if (typeof localStorage !== "undefined") {
    try {
      const raw = localStorage.getItem(PREFS_SCALAR_KEYS[key]);
      return raw === "sm2" || raw === "fsrs" ? raw : DEFAULT_CARDS_ALGORITHM;
    } catch {
      // Fall through to the default.
    }
  }
  return DEFAULT_CARDS_ALGORITHM;
}

/** Write one device-local prefs scalar (localStorage; memory needs none). */
export function writeDevicePrefScalar(
  key: keyof typeof PREFS_SCALAR_KEYS,
  value: CardsAlgorithm,
): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(PREFS_SCALAR_KEYS[key], value);
    }
  } catch {
    // Storage unavailable; the server push below is the durable write.
  }
}

/** Server body → UserPrefs; a malformed answer is a loud error, never half-read. */
export function normalizeUserPrefs(body: unknown): UserPrefs {
  const value = body as { favorites?: unknown; recents?: unknown; cardsAlgorithm?: unknown };
  const asIds = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((entry): entry is string => typeof entry === "string") : [];
  return {
    favorites: asIds(value?.favorites),
    recents: asIds(value?.recents),
    cardsAlgorithm: value?.cardsAlgorithm === "sm2" ? "sm2" : "fsrs",
  };
}

/** Star toggle: add/remove an id, preserving the existing order. */
export function mergeFavoriteToggle(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];
}

/** Recents open: most-recent-first, deduped, capped at MAX_SYNCED_RECENTS. */
export function mergeRecentOpen(list: readonly string[], id: string): string[] {
  return [id, ...list.filter((entry) => entry !== id)].slice(0, MAX_SYNCED_RECENTS);
}

