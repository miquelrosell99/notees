/**
 * classRemoval — the non-removable-class rule: the journal chain classes
 * are identity-bearing (the year/month/day journal chain per the seed
 * manifest), so class-membership removal is refused for them everywhere the
 * UI offers ×-removal (NodePills — the page classes row AND the block-row
 * classes column —, the classed-nodes section, the node context menu, and
 * the selection bar's bulk unassign). (The seeded `class` meta class left
 * the list with its 2026-10-07 retirement — it is no longer seeded.)
 *
 * The refusal is UI-level and honest: the × stays visible, the click
 * surfaces an explanatory toast, and no write is issued. (The server/CLI
 * REST surface stays ungated — a deliberate admin escape hatch, same as
 * the original shell.)
 */

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { notificationStore } from "./ui/notificationStore.js";

/** Class ids whose membership ×-removal is refused (the journal chain). */
const NON_REMOVABLE_CLASS_IDS: ReadonlySet<string> = new Set([
  SYSTEM_CLASS_UUIDS.year,
  SYSTEM_CLASS_UUIDS.month,
  SYSTEM_CLASS_UUIDS.day,
]);

/** The refusal message for a non-removable class id, or null when removable. */
export function classRemovalRefusal(classId: string): string | null {
  if (!NON_REMOVABLE_CLASS_IDS.has(classId)) return null;
  return "Journal classes are identity-bearing — they can't be removed from a node.";
}

/**
 * Enforce the rule for one attempted removal: refuses (toast + true) when
 * the class is non-removable; no-op false otherwise.
 */
export function refuseClassRemoval(classId: string): boolean {
  const refusal = classRemovalRefusal(classId);
  if (refusal === null) return false;
  notificationStore.warning("Class can't be removed", refusal);
  return true;
}

/** True when the class pill's × is replaced by the non-removable lock. */
export function isClassNonRemovable(classId: string): boolean {
  return NON_REMOVABLE_CLASS_IDS.has(classId);
}
