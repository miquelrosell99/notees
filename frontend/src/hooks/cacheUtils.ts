/**
 * Cache utilities for TanStack Query
 *
 * Unified helpers for manipulating node caches during optimistic updates.
 * These encapsulate the cache-finding and cache-update patterns that were
 * previously duplicated across ~9 mutation hooks.
 *
 * All helpers use explicit cache iteration (findAll + setQueryData per query)
 * instead of setQueriesData with partial keys. The partial-key approach was
 * proven unreliable for deeply nested block structures (level 3+).
 */
import type { Query, QueryClient, QueryCache } from '@tanstack/react-query';
import type { Node, LinkedReference, PropertyBacklink } from '@/types/api';
import { nodeKeys } from './queryKeys';
import { nodeViewKeys } from './useNodeViews';

// =============================================================================
// Cache Finders
// =============================================================================

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
 * Find all detail queries (any node).
 */
export function findAllDetailCaches(queryCache: QueryCache): Query[] {
  return queryCache.findAll({ queryKey: nodeKeys.details() });
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

/**
 * Find all list caches (sidebar, search).
 */
export function findListCaches(queryCache: QueryCache): Query[] {
  return queryCache.findAll({ queryKey: nodeKeys.lists() });
}

/**
 * Find all linked-references caches.
 */
export function findLinkedRefCaches(queryCache: QueryCache): Query[] {
  return queryCache.findAll({ queryKey: nodeKeys.allLinkedRefs() });
}

/**
 * Find all property-backlinks caches.
 */
export function findPropertyBacklinkCaches(queryCache: QueryCache): Query[] {
  return queryCache.findAll({ queryKey: ['nodes', 'property-backlinks'] });
}

// =============================================================================
// Internal Tree Traversal Helpers
// =============================================================================

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

function insertChildIntoNode(node: Node, parentId: number, childNode: Node): Node {
  if (node.id === parentId) {
    const existing = node.children || [];
    if (existing.some(c => c.id === childNode.id)) return node;
    const insertIdx = existing.findIndex(c => (c.sequence ?? 0) > (childNode.sequence ?? 0));
    const newChildren =
      insertIdx === -1
        ? [...existing, childNode]
        : [...existing.slice(0, insertIdx), childNode, ...existing.slice(insertIdx)];
    return { ...node, children: newChildren };
  }
  if (node.children && node.children.length > 0) {
    let changed = false;
    const newChildren = node.children.map(child => {
      const updated = insertChildIntoNode(child, parentId, childNode);
      if (updated !== child) changed = true;
      return updated;
    });
    if (changed) return { ...node, children: newChildren };
  }
  return node;
}

function replaceNodeInTree(node: Node, oldId: number, newNode: Node): Node {
  if (node.children && node.children.length > 0) {
    const newChildren = node.children.map(child => {
      if (child.id === oldId) {
        // Preserve children from the optimistic node if the real node has none
        return { ...newNode, children: newNode.children?.length ? newNode.children : child.children };
      }
      return replaceNodeInTree(child, oldId, newNode);
    });
    if (newChildren !== node.children) {
      return { ...node, children: newChildren };
    }
  }
  return node;
}


function insertAtPosition(children: Node[], nodeToInsert: Node, pos: number): Node[] {
  const newChildren = [...children];
  newChildren.splice(pos, 0, nodeToInsert);
  return newChildren.map((child, idx) => ({ ...child, sequence: idx }));
}

function insertNodeAtParent(node: Node, nodeToInsert: Node, targetParentId: number, pos: number): Node {
  if (node.id === targetParentId) {
    const currentChildren = node.children || [];
    return { ...node, children: insertAtPosition(currentChildren, nodeToInsert, pos) };
  }
  if (node.children && node.children.length > 0) {
    return {
      ...node,
      children: node.children.map(child => insertNodeAtParent(child, nodeToInsert, targetParentId, pos)),
    };
  }
  return node;
}

// =============================================================================
// Unified Tree Cache Updaters
// =============================================================================

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
export function removeNodeFromAllCaches(queryClient: QueryClient, nodeId: number): boolean {
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

/**
 * Insert a child node into a parent's children array across all tree caches.
 * The child is inserted at the correct position based on its sequence field.
 * Returns true if any cache was modified.
 */
export function insertChildIntoTreeCaches(
  queryClient: QueryClient,
  parentId: number,
  childNode: Node
): boolean {
  const queryCache = queryClient.getQueryCache();
  let modified = false;

  const applyToQuery = (query: Query) => {
    const oldData = query.state.data as Node | undefined;
    if (!oldData) return;
    const newData = insertChildIntoNode(oldData, parentId, childNode);
    if (newData !== oldData) {
      queryClient.setQueryData(query.queryKey, newData);
      modified = true;
    }
  };

  for (const query of findAllDetailCaches(queryCache)) applyToQuery(query);
  for (const query of findPageContentCaches(queryCache)) applyToQuery(query);
  for (const query of findUuidCaches(queryCache)) applyToQuery(query);

  return modified;
}

/**
 * Replace an optimistic node (or any node by ID) with a new node across all tree caches.
 * Preserves the old node's children if the new node has no children.
 * Returns true if any cache was modified.
 */
export function replaceNodeInTreeCaches(
  queryClient: QueryClient,
  oldId: number,
  newNode: Node
): boolean {
  const queryCache = queryClient.getQueryCache();
  let modified = false;

  const applyToQuery = (query: Query) => {
    const oldData = query.state.data as Node | undefined;
    if (!oldData) return;
    const newData = replaceNodeInTree(oldData, oldId, newNode);
    if (newData !== oldData) {
      queryClient.setQueryData(query.queryKey, newData);
      modified = true;
    }
  };

  for (const query of findAllDetailCaches(queryCache)) applyToQuery(query);
  for (const query of findPageContentCaches(queryCache)) applyToQuery(query);
  for (const query of findUuidCaches(queryCache)) applyToQuery(query);

  return modified;
}

/**
 * Move a node to a new parent and sequence across all tree caches.
 * First removes the node from its current location, then inserts at the new parent.
 * Returns true if any cache was modified.
 */
export function moveNodeInTreeCaches(
  queryClient: QueryClient,
  nodeId: number,
  newParentId: number | null,
  newSequence: number,
  movedNode: Node
): boolean {
  const queryCache = queryClient.getQueryCache();
  let modified = false;

  const updatedNode = { ...movedNode, parent_id: newParentId, sequence: newSequence };

  const applyToQuery = (query: Query) => {
    const oldData = query.state.data as Node | undefined;
    if (!oldData) return;

    // First remove from anywhere in the tree
    let result = removeNodeFromTree(oldData, nodeId);

    // Then insert at new parent if applicable
    if (newParentId !== null) {
      result = insertNodeAtParent(result, updatedNode, newParentId, newSequence);
    }

    if (result !== oldData) {
      queryClient.setQueryData(query.queryKey, result);
      modified = true;
    }
  };

  for (const query of findAllDetailCaches(queryCache)) applyToQuery(query);
  for (const query of findPageContentCaches(queryCache)) applyToQuery(query);
  for (const query of findUuidCaches(queryCache)) applyToQuery(query);

  return modified;
}

// =============================================================================
// Flat Cache Updaters
// =============================================================================

/**
 * Update a node in flat array caches (queryResults, pseudoNodeQuery, inlineQuery).
 * Returns true if any cache was modified.
 */
export function updateNodeInFlatCaches(
  queryClient: QueryClient,
  nodeId: number,
  updater: (node: Node) => Node
): boolean {
  const queryCache = queryClient.getQueryCache();
  let modified = false;

  for (const query of findFlatNodeCaches(queryCache)) {
    const oldData = query.state.data as Node[] | undefined;
    if (oldData && Array.isArray(oldData)) {
      let changed = false;
      const newData = oldData.map(n => {
        if (n.id === nodeId) {
          changed = true;
          return updater(n);
        }
        return n;
      });
      if (changed) {
        queryClient.setQueryData(query.queryKey, newData);
        modified = true;
      }
    }
  }

  return modified;
}

/**
 * Remove a node from flat array caches (queryResults, pseudoNodeQuery, inlineQuery).
 * Returns true if any cache was modified.
 */
export function removeNodeFromFlatCaches(queryClient: QueryClient, nodeId: number): boolean {
  const queryCache = queryClient.getQueryCache();
  let modified = false;

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

/**
 * Update a node in list caches (sidebar, search).
 * Returns true if any cache was modified.
 */
export function updateNodeInListCaches(
  queryClient: QueryClient,
  nodeId: number,
  updater: (node: Node) => Node
): boolean {
  const queryCache = queryClient.getQueryCache();
  let modified = false;

  for (const query of findListCaches(queryCache)) {
    const oldData = query.state.data as Node[] | undefined;
    if (oldData && Array.isArray(oldData)) {
      let changed = false;
      const newData = oldData.map(n => {
        if (n.id === nodeId) {
          changed = true;
          return updater(n);
        }
        return n;
      });
      if (changed) {
        queryClient.setQueryData(query.queryKey, newData);
        modified = true;
      }
    }
  }

  return modified;
}

// =============================================================================
// Special Cache Updaters
// =============================================================================

/**
 * Remove a node from linked-references caches.
 * Returns true if any cache was modified.
 */
export function removeNodeFromLinkedRefCaches(queryClient: QueryClient, nodeId: number): boolean {
  const queryCache = queryClient.getQueryCache();
  let modified = false;

  for (const query of findLinkedRefCaches(queryCache)) {
    const oldData = query.state.data as { linked_references: LinkedReference[]; total_count: number } | undefined;
    if (oldData && oldData.linked_references) {
      const newRefs = oldData.linked_references.filter(ref => ref.source_node.id !== nodeId);
      if (newRefs.length !== oldData.linked_references.length) {
        queryClient.setQueryData(query.queryKey, {
          ...oldData,
          linked_references: newRefs,
          total_count: Math.max(0, oldData.total_count - 1),
        });
        modified = true;
      }
    }
  }

  return modified;
}

/**
 * Remove a node from property-backlinks caches.
 * Returns true if any cache was modified.
 */
export function removeNodeFromPropertyBacklinkCaches(
  queryClient: QueryClient,
  nodeId: number
): boolean {
  const queryCache = queryClient.getQueryCache();
  let modified = false;

  for (const query of findPropertyBacklinkCaches(queryCache)) {
    const oldData = query.state.data as PropertyBacklink[] | undefined;
    if (oldData && Array.isArray(oldData)) {
      const newData = oldData.filter(ref => ref.source_page.id !== nodeId);
      if (newData.length !== oldData.length) {
        queryClient.setQueryData(query.queryKey, newData);
        modified = true;
      }
    }
  }

  return modified;
}

// =============================================================================
// Unified High-Level Helper
// =============================================================================

/**
 * The single entry-point for all node cache mutations.
 * Dispatches to the appropriate low-level helper based on the operation type.
 * This is what mutation hooks should call instead of inline cache manipulation.
 */
export type CacheMutationOperation =
  | { type: 'update'; nodeId: number; updater: (node: Node) => Node }
  | { type: 'remove'; nodeId: number }
  | { type: 'insertChild'; parentId: number; childNode: Node }
  | { type: 'replace'; oldId: number; newNode: Node }
  | { type: 'move'; nodeId: number; newParentId: number | null; newSequence: number; movedNode: Node };

export function mutateNodeTree(
  queryClient: QueryClient,
  operation: CacheMutationOperation
): boolean {
  switch (operation.type) {
    case 'update':
      return updateNodeInTreeCaches(queryClient, operation.nodeId, operation.updater);
    case 'remove':
      return removeNodeFromAllCaches(queryClient, operation.nodeId);
    case 'insertChild':
      return insertChildIntoTreeCaches(queryClient, operation.parentId, operation.childNode);
    case 'replace':
      return replaceNodeInTreeCaches(queryClient, operation.oldId, operation.newNode);
    case 'move':
      return moveNodeInTreeCaches(
        queryClient,
        operation.nodeId,
        operation.newParentId,
        operation.newSequence,
        operation.movedNode
      );
    default:
      return false;
  }
}
