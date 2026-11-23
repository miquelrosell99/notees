/**
 * childQuery — the body's item-resolution factory (the main-content
 * restructure): the body of both modes is the plain NodeCollection
 * dispatcher, fed by this one factory living beside the SectionSpec
 * factories. Page mode: the node's children as top-level items. Block mode
 * (`showRoot`): the node itself as the single root item with its children
 * under it — the verified item-shape difference (ReferenceSubtree
 * renders the root BlockRow + recursive children; no NodeCollectionProps
 * addition).
 *
 * Children classed `comment` are excluded at EVERY level, with their
 * whole subtrees — comments never render in the main body (the original
 * precedent, NodeTreeProjection's `is_comment` skip); they surface only in
 * the Comments section of the context column (components/CommentsSection.tsx).
 */

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { BlockTreeNode, WorkspaceClient } from "@/core/workspace-client/index.js";

import type { NodeCollectionItem } from "./index.js";

type AnyClient = WorkspaceClient | WorkerClient;

export interface ChildQueryOptions {
  /**
   * Block mode: the node itself is the single root item (`items=[{node,
   * children}]`); false (default, page mode): its children as siblings.
   */
  showRoot?: boolean;
}

/** Comment-classed rows never render in the main body (whole subtree cut). */
function notComment(entry: BlockTreeNode): boolean {
  return !entry.node.classIds.includes(SYSTEM_CLASS_UUIDS.comment);
}



/**
 * Structural sharing across re-serves (the per-keystroke render-churn
 * fix): `getBlockTree` re-serves the open page's tree on every edit — new
 * wrapper objects at every level, though unchanged rows KEEP their node
 * identity (the worker's per-row map cache). Without reuse, every serve
 * rebuilt every item fresh, and the memoized BlockRow's comparator then
 * deep-walked EVERY row's whole subtree per parent re-render — O(page ×
 * depth) of pointer-chasing on the main thread per keystroke. The reuse
 * compare below is O(page) by (id + node identity + filtered children);
 * an unchanged entry reuses its PREVIOUS item object, so downstream
 * `toBlockTree` wrappers and the row props stay reference-stable across
 * renders that changed nothing, and the row memo bails on its O(1)
 * reference fast-path. The cache is per (client, nodeId, showRoot) — a
 * WeakMap on the client keeps it out of the way of GC.
 */
const itemCache = new WeakMap<AnyClient, Map<string, { items: NodeCollectionItem[] }>>();

function buildItems(entries: readonly BlockTreeNode[]): NodeCollectionItem[] {
  return entries.filter(notComment).map((entry) => ({
    node: entry.node,
    children: buildItems(entry.children),
  }));
}

/** Per-entry reuse: a changed row rebuilds its own item and its ancestors'
 *  child arrays; every unchanged entry (deep, by node identity + filtered
 *  children) keeps its PREVIOUS item object. */
function reuseList(
  prev: NodeCollectionItem[] | undefined,
  entries: readonly BlockTreeNode[],
): NodeCollectionItem[] {
  const filtered = entries.filter(notComment);
  if (prev === undefined || prev.length !== filtered.length) return buildItems(filtered);
  let allReused = true;
  const out = filtered.map((entry, i) => {
    const prevItem = prev[i]!;
    const children = reuseList(prevItem.children, entry.children);
    if (prevItem.node === entry.node && children === prevItem.children) {
      return prevItem;
    }
    allReused = false;
    return { node: entry.node, children };
  });
  return allReused ? prev : out;
}

export function childQuery(
  client: AnyClient,
  nodeId: string,
  { showRoot = false }: ChildQueryOptions = {},
): NodeCollectionItem[] {
  const entries = client.getBlockTree(nodeId);
  let perClient = itemCache.get(client);
  if (perClient === undefined) {
    perClient = new Map();
    itemCache.set(client, perClient);
  }
  const cacheKey = `${nodeId}:${showRoot ? "root" : "page"}`;
  const prev = perClient.get(cacheKey);
  const items = reuseList(prev?.items, entries);
  perClient.set(cacheKey, { items });
  if (!showRoot) return items;
  const root = client.getNode(nodeId);
  return root === undefined ? [] : [{ node: root, children: items }];
}
