/**
 * nestItems — the nestUnderParents display-time nesting helper.
 *
 * A flat item set becomes a tree purely from `node.parentId` membership
 * (the Pages hub's all-pages ruling): an item is TOP-LEVEL when its parent
 * is null or not in the set; otherwise it attaches to its in-set parent's
 * `children`, input order kept at every level. Structural cycles are
 * write-time impossible (the operation-level guards) — the parent-chain
 * walk still fails soft: a chain that revisits an id treats the walker as
 * top-level instead of hanging. The input items are never mutated; only
 * parents with children get a fresh `{...item, children}` wrapper.
 */

import type { NodeCollectionItem } from "./types.js";

export function nestItems(items: readonly NodeCollectionItem[]): NodeCollectionItem[] {
  const byId = new Map<string, NodeCollectionItem>();
  for (const item of items) byId.set(item.node.id, item);

  // Cycle guard, applied to the walker's whole parent chain: revisiting an
  // id means an impossible parent loop — the walker stays top-level.
  const chainRevisits = (item: NodeCollectionItem): boolean => {
    const seen = new Set<string>([item.node.id]);
    let current = item.node.parentId;
    while (current !== null) {
      const parent = byId.get(current);
      if (parent === undefined) return false;
      if (seen.has(current)) return true;
      seen.add(current);
      current = parent.node.parentId;
    }
    return false;
  };

  const topLevel: NodeCollectionItem[] = [];
  const childrenOf = new Map<string, NodeCollectionItem[]>();
  for (const item of items) {
    const parentId = item.node.parentId;
    if (parentId === null || !byId.has(parentId) || chainRevisits(item)) {
      topLevel.push(item);
      continue;
    }
    const siblings = childrenOf.get(parentId);
    if (siblings === undefined) childrenOf.set(parentId, [item]);
    else siblings.push(item);
  }

  const build = (item: NodeCollectionItem): NodeCollectionItem => {
    const children = childrenOf.get(item.node.id);
    return children === undefined ? item : { ...item, children: children.map(build) };
  };
  return topLevel.map(build);
}
