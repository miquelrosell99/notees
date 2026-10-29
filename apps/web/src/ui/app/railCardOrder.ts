/**
 * railCardOrder — the right rail's workspace-card stack order (device-local).
 *
 * A plain validated localStorage list, exactly the recents-order precedent
 * (`notees.recents` in Sidebar.tsx) — device-local UI chrome, no server
 * counterpart, never an op. The order IS the peek recency (most recent
 * first); there is no reorder gesture to persist beyond open/close.
 */

import { STORAGE_KEYS, writeStored } from "./storage.js";

/**
 * The rail's card order persistence: a plain validated localStorage list,
 * exactly the recents-order precedent (`notees.recents` in Sidebar.tsx) —
 * device-local UI chrome, no server counterpart, never an op. Exported for
 * the rail-order tests.
 */
export function readRailCardOrder(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEYS.railCardOrder) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

export function persistRailCardOrder(order: readonly string[]): void {
  writeStored(STORAGE_KEYS.railCardOrder, JSON.stringify(order));
}
