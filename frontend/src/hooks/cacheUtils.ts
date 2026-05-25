/**
 * Cache utilities for TanStack Query
 *
 * Shared helpers for manipulating node caches during optimistic updates.
 * These encapsulate the cache-finding patterns that are repeated across
 * useNodeMutations, useBlockPersist, and useStructureSync.
 */
import type { Query, QueryClient, QueryCache } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import { nodeKeys } from './queryKeys';
import { nodeViewKeys } from './useNodeViews';

// ==================== Cache Finders ====================

/**
 * Find all page-content queries in the cache (regardless of node ID).
 */
export function findPageContentCaches(queryCache: QueryCache): Query[] {
  return queryCache.findAll({ queryKey: nodeKeys.pageContents() });
}

/**
 * Find all by-uuid queries in the cache.
 */
export function findUuidCaches(queryCache: QueryCache): Query[] {
  return queryCache.findAll({ queryKey: nodeKeys.uuids() });
}

/**
 * Find all detail queries for a specific node ID.
 */
export function findDetailCachesForNode(queryCache: QueryCache, nodeId: number): Query[] {
  return queryCache.findAll({ queryKey: nodeKeys.detailBase(nodeId) });
}

/**
 * Find all flat Node[] result caches (query results, pseudo-node queries, inline queries).
 */
export function findFlatNodeCaches(queryCache: QueryCache): Query[] {
  return [
    ...queryCache.findAll({ queryKey: nodeViewKeys.queryResults() }),
    ...queryCache.findAll({ queryKey: nodeKeys.pseudoNodeQuery() }),
    ...queryCache.findAll({ queryKey: nodeKeys.inlineQuery() }),
  ];
}

// ==================== Node Cache Updaters ====================

/**
 * Update a node everywhere it appears in tree caches (detail, page-content, uuid).
 * Returns true if any cache was modified.
 */
export function updateNodeInTreeCaches(
  queryClient: QueryClient,
  nodeId: number,
  updater: (node: Node) => Node
): boolean {
  const queryCache = queryClient.getQueryCache();
  let modified = false;

  const applyToQuery = (query: Query) => {
    const oldData = query.state.data as Node | undefined;
    if (!oldData) return;
    const newData = applyUpdateToNode(oldData, nodeId, updater);
    if (newData !== oldData) {
      queryClient.setQueryData(query.queryKey, newData);
      modified = true;
    }
  };

  for (const query of findPageContentCaches(queryCache)) applyToQuery(query);
  for (const query of findUuidCaches(queryCache)) applyToQuery(query);
  for (const query of findDetailCachesForNode(queryCache, nodeId)) applyToQuery(query);

  return modified;
}

/**
 * Remove a node from all tree caches (detail, page-content, uuid).
 * Also removes the node from flat Node[] result caches.
 * Returns true if any cache was modified.
 */
export function removeNodeFromAllCaches(
  queryClient: QueryClient,
  nodeId: number
): boolean {
  const queryCache = queryClient.getQueryCache();
  let modified = false;

  const removeFromTree = (query: Query) => {
    const oldData = query.state.data as Node | undefined;
    if (!oldData) return;
    const newData = removeNodeFromTree(oldData, nodeId);
    if (newData !== oldData) {
      queryClient.setQueryData(query.queryKey, newData);
      modified = true;
    }
  };

  for (const query of findPageContentCaches(queryCache)) removeFromTree(query);
  for (const query of findUuidCaches(queryCache)) removeFromTree(query);
  for (const query of findDetailCachesForNode(queryCache, nodeId)) removeFromTree(query);

  // Also remove from flat result caches
  for (const query of findFlatNodeCaches(queryCache)) {
    const oldData = query.state.data as Node[] | undefined;
    if (oldData && Array.isArray(oldData)) {
      const newData = oldData.filter(n => n.id !== nodeId);
      if (newData.length !== oldData.length) {
        queryClient.setQueryData(query.queryKey, newData);
        modified = true;
      }
    }
  }

  return modified;
}

// ==================== Tree Traversal Helpers ====================

/**
 * Recursively apply an updater to a node and all its children.
 */
function applyUpdateToNode(node: Node, targetId: number, updater: (node: Node) => Node): Node {
  if (node.id === targetId) {
    return updater(node);
  }
  if (node.children && node.children.length > 0) {
    const newChildren = node.children.map(child => applyUpdateToNode(child, targetId, updater));
    if (newChildren !== node.children) {
      return { ...node, children: newChildren };
    }
  }
  return node;
}

/**
 * Recursively remove a node from a tree.
 */
function removeNodeFromTree(node: Node, targetId: number): Node {
  if (node.children && node.children.length > 0) {
    const newChildren = node.children
      .filter(child => child.id !== targetId)
      .map(child => removeNodeFromTree(child, targetId));
    if (newChildren.length !== node.children.length) {
      return { ...node, children: newChildren };
    }
  }
  return node;
}
