/**
 * collectionSort — the named sort modes' comparators (the sort-button
 * vocabulary the list and cards views share; the table view keeps its
 * per-column SortSpec machinery). The modes:
 *
 * - `dates-first` (list): date pages first, newest → oldest, then the other
 *   pages A–Z; the within-page order (group rows, tree siblings) keeps the
 *   container's position order — the mode orders PAGES, never blocks.
 * - `alphabetical`: by display name A–Z (display-name derivation rides
 *   `displayNameForSettings`, the same text the table name column sorts).
 * - `edit-date` (cards): by `updatedAt`, most recently edited first, nulls
 *   last (the table's Edited column default).
 *
 * Every comparator ends in the id tiebreak — sorts are stable AND
 * deterministic whatever the input order was.
 */

import { parseDateNodeId } from "@notees/domain";

import type { ClientNode } from "@/core/workspace-client.js";

import { displayNameForSettings } from "../dateDisplay.js";
import type { CollectionGroup, NodeCollectionItem, SortMode } from "./types.js";

type NameResolver = (classId: string) => string | null;

/**
 * The precision-aware sort key of a date-chain node id — `2026`,
 * `2026-10`, `2026-10-13` — so a plain lexicographic compare orders the
 * chain coherently (a day sorts with its date, after its month, after its
 * year); null for any non-date id.
 */
export function dateSortKeyOf(nodeId: string): string | null {
  const parsed = parseDateNodeId(nodeId);
  if (parsed === null) return null;
  const mm = String(parsed.month).padStart(2, "0");
  const dd = String(parsed.day).padStart(2, "0");
  if (parsed.precision === "year") return `${parsed.year}`;
  if (parsed.precision === "month") return `${parsed.year}-${mm}`;
  return `${parsed.year}-${mm}-${dd}`;
}

function displayNameOf(node: ClientNode, resolveName?: NameResolver): string {
  return displayNameForSettings(node, resolveName) || "Untitled";
}

function compareNames(a: ClientNode, b: ClientNode, resolveName?: NameResolver): number {
  const compared = displayNameOf(a, resolveName).localeCompare(displayNameOf(b, resolveName), undefined, {
    numeric: true,
    sensitivity: "base",
  });
  return compared !== 0 ? compared : a.id.localeCompare(b.id);
}

/** Dates first: date pages newest → oldest, then the other pages A–Z. */
function compareDatesFirst(a: ClientNode, b: ClientNode, resolveName?: NameResolver): number {
  const keyA = dateSortKeyOf(a.id);
  const keyB = dateSortKeyOf(b.id);
  if (keyA !== null && keyB !== null) {
    const compared = keyB.localeCompare(keyA);
    if (compared !== 0) return compared;
    return a.id.localeCompare(b.id);
  }
  if (keyA !== null) return -1;
  if (keyB !== null) return 1;
  return compareNames(a, b, resolveName);
}

/**
 * The flat-list item comparator for a list mode (`position` never reaches
 * here — it is the unsorted identity).
 */
export function compareItemsByMode(
  mode: Exclude<SortMode, "position" | "edit-date">,
  resolveName?: NameResolver,
): (a: NodeCollectionItem, b: NodeCollectionItem) => number {
  return (a, b) =>
    mode === "dates-first"
      ? compareDatesFirst(a.node, b.node, resolveName)
      : compareNames(a.node, b.node, resolveName);
}

/** The cards comparator: edit date, most recent first, nulls last, then name. */
export function compareItemsByEditDate(
  resolveName?: NameResolver,
): (a: NodeCollectionItem, b: NodeCollectionItem) => number {
  return (a, b) => {
    const updatedA = a.node.updatedAt;
    const updatedB = b.node.updatedAt;
    const emptyA = updatedA === null || updatedA === "";
    const emptyB = updatedB === null || updatedB === "";
    if (emptyA !== emptyB) return emptyA ? 1 : -1;
    if (!emptyA && updatedA !== updatedB) return updatedB!.localeCompare(updatedA!);
    return compareNames(a.node, b.node, resolveName);
  };
}

/**
 * The grouped-list comparator: it orders the GROUPS (by their key page —
 * the containing page); the rows inside a group always keep their position
 * order.
 */
export function compareGroupsByMode(
  mode: Exclude<SortMode, "position" | "edit-date">,
): (a: CollectionGroup, b: CollectionGroup) => number {
  return (a, b) => {
    if (mode === "dates-first") {
      const keyA = dateSortKeyOf(a.id);
      const keyB = dateSortKeyOf(b.id);
      if (keyA !== null && keyB !== null) {
        const compared = keyB.localeCompare(keyA);
        if (compared !== 0) return compared;
        return a.id.localeCompare(b.id);
      }
      if (keyA !== null) return -1;
      if (keyB !== null) return 1;
    }
    const compared = a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" });
    return compared !== 0 ? compared : a.id.localeCompare(b.id);
  };
}

/**
 * Sort every sibling level of an item tree by a list mode (`position` =
 * the identity — the tree keeps the container's order). Returns new arrays
 * all the way down; the input is never mutated.
 */
export function sortTreeByMode(
  items: NodeCollectionItem[],
  mode: Exclude<SortMode, "position" | "edit-date">,
  resolveName?: NameResolver,
): NodeCollectionItem[] {
  const compare = compareItemsByMode(mode, resolveName);
  const sortLevel = (level: NodeCollectionItem[]): NodeCollectionItem[] =>
    level
      .map((item) => ({
        ...item,
        children: item.children === undefined ? undefined : sortLevel(item.children),
      }))
      .sort(compare);
  return sortLevel(items);
}
