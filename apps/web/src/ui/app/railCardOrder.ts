/**
 * railCardOrder — the right rail's workspace-card stack order (device-local).
 *
 * A plain validated localStorage list, exactly the recents-order precedent
 * (`notees.recents` in Sidebar.tsx) — device-local UI chrome, no server
 * counterpart, never an op. The pure `moveRailCardOrder` is the reorder move
 * behind the workspace drag session's report (App owns the stack state).
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

/**
 * The rail's reorder move (pure): lift `activeId` out and re-insert it at
 * the target's edge. Dropping onto itself, either end unknown, or exactly
 * in place returns the input reference (React bails — no render, no
 * persistence write). Exported for the rail-order tests.
 */
export function moveRailCardOrder(
  order: readonly string[],
  activeId: string,
  targetId: string,
  position: "before" | "after",
): string[] {
  if (activeId === targetId) return order as string[];
  if (!order.includes(activeId)) return order as string[];
  const rest = order.filter((id) => id !== activeId);
  const index = rest.indexOf(targetId);
  if (index < 0) return order as string[];
  const insertAt = position === "before" ? index : index + 1;
  const next = [...rest.slice(0, insertAt), activeId, ...rest.slice(insertAt)];
  if (next.every((id, i) => id === order[i])) return order as string[];
  return next;
}
