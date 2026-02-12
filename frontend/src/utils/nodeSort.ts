/**
 * Node sorting utilities.
 *
 * All sorting is performed at the view level — the query layer fetches and
 * filters, views sort, and projection renders in the order given.
 */
import type { Node } from '@/types';
import { parseDateUuid } from '@/types/api';

// ─── Helpers ──────────────────────────────────────────────────────

/** Check whether a node represents a date (day, month, or year). */
export function isDateNode(node: Node): boolean {
  return !!(node.is_daily || node.is_monthly || node.is_yearly);
}

/**
 * Extract a comparable numeric value from a date node's UUID so that
 * more-recent dates sort first (descending).
 * Returns `0` when the UUID can't be parsed.
 */
function dateNodeSortKey(node: Node): number {
  const info = parseDateUuid(node.uuid);
  if (!info) return 0;
  // Encode as YYYYMMDD numeric – month/year nodes get DD=0, year nodes MM=0
  return info.year * 10000 + (info.month ?? 0) * 100 + (info.day ?? 0);
}

// ─── Comparators ──────────────────────────────────────────────────

/**
 * Compare two nodes by `sequence` (ascending).
 * Nodes without a sequence are pushed to the end.
 */
export function compareBySequence(a: Node, b: Node): number {
  return (a.sequence ?? Infinity) - (b.sequence ?? Infinity);
}

/**
 * Compare two nodes using the "dates-first-descending, then alphabetically"
 * ordering used for group-by parent / root nodes.
 *
 * 1. Date nodes come before non-date nodes.
 * 2. Among date nodes, sort descending (newest first).
 * 3. Among non-date nodes, sort alphabetically by name (case-insensitive).
 */
export function compareDateFirstAlpha(a: Node, b: Node): number {
  const aDate = isDateNode(a);
  const bDate = isDateNode(b);

  if (aDate && bDate) {
    // Both dates → newest first (descending)
    return dateNodeSortKey(b) - dateNodeSortKey(a);
  }
  if (aDate) return -1; // date before non-date
  if (bDate) return 1;

  // Both non-date → alphabetical
  const aName = (a.name ?? '').toLowerCase();
  const bName = (b.name ?? '').toLowerCase();
  return aName.localeCompare(bName);
}

/**
 * Compare two nodes by `write_date` (descending — most recently modified first).
 */
export function compareByWriteDateDesc(a: Node, b: Node): number {
  const aDate = a.write_date ? new Date(a.write_date).getTime() : 0;
  const bDate = b.write_date ? new Date(b.write_date).getTime() : 0;
  return bDate - aDate; // descending
}

/**
 * Compare two nodes by `create_date` (descending — newest first).
 */
export function compareByCreateDateDesc(a: Node, b: Node): number {
  const aDate = a.create_date ? new Date(a.create_date).getTime() : 0;
  const bDate = b.create_date ? new Date(b.create_date).getTime() : 0;
  return bDate - aDate;
}

// ─── Convenience sort functions ───────────────────────────────────

/** Sort an array of nodes by sequence (ascending). Returns a new array. */
export function sortBySequence(nodes: Node[]): Node[] {
  return [...nodes].sort(compareBySequence);
}

/**
 * Sort group-by parent nodes: dates first (descending), then alphabetical.
 * Returns a new array.
 */
export function sortDateFirstAlpha(nodes: Node[]): Node[] {
  return [...nodes].sort(compareDateFirstAlpha);
}

/** Sort nodes by write_date descending. Returns a new array. */
export function sortByWriteDateDesc(nodes: Node[]): Node[] {
  return [...nodes].sort(compareByWriteDateDesc);
}
