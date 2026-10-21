/**
 * recentPages — the device-local Recents list storage (the sidebar section).
 *
 * The recents surfaces agree on one storage shape: a JSON string array of
 * node ids under `notees.recents`, most-recently-used first, capped at
 * MAX_SYNCED_RECENTS. `recordRecent` is the single device-local write — every
 * open surface funnels through App.openPage, which calls it; the write
 * broadcasts `notees:recents` so every listener refreshes live. The nodePrefs
 * store listens and mirrors the list to the server prefs when online. The
 * node picker's empty state and the command palette read through
 * `readRecentIds` so their Recent sections match the sidebar's.
 *
 * Extracted from Sidebar.tsx (owner 2026-10-21) with the Favorites/Recents
 * sections — the storage seam has callers outside the sidebar (App.openPage,
 * the pickers), so it lives in its own module next to the feature.
 */

import { MAX_SYNCED_RECENTS } from "@/core/workspace-client/index.js";

export const STORAGE_KEYS = {
  favorites: "notees.favorites",
  recents: "notees.recents",
} as const;

export function readStoredJson(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Record a page open in the device-local Recents list. Every open surface
 * funnels through App.openPage, which calls this; the write broadcasts
 * `notees:recents` so the sidebar refreshes live (same pattern as the
 * favorites broadcast from the node context menu). The nodePrefs store
 * listens and mirrors the list to the server prefs when online — this
 * function stays the single device-local write.
 */
export function recordRecent(id: string): void {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEYS.recents) || "[]");
    const previous = Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
    const next = [id, ...previous.filter((entry) => entry !== id)].slice(0, MAX_SYNCED_RECENTS);
    localStorage.setItem(STORAGE_KEYS.recents, JSON.stringify(next));
  } catch {
    // Storage unavailable; the list just won't persist.
  }
  window.dispatchEvent(new Event("notees:recents"));
}

/**
 * Read the device-local Recents list (ids, most-recently-used first). The
 * node picker's empty state and the command palette both read through here
 * so the recents surfaces agree on the storage shape.
 */
export function readRecentIds(): string[] {
  return readStoredJson(STORAGE_KEYS.recents);
}

/**
 * Remove a page from the device-local Recents list (the row context menu).
 * Same broadcast contract as recordRecent so every listener refreshes live.
 */
export function removeRecent(id: string): void {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEYS.recents) || "[]");
    const previous = Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
    localStorage.setItem(STORAGE_KEYS.recents, JSON.stringify(previous.filter((entry) => entry !== id)));
  } catch {
    // Storage unavailable; the list just won't persist.
  }
  window.dispatchEvent(new Event("notees:recents"));
}
