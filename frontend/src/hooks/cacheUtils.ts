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
import { nodeKeys, nodeViewKeys } from './queryKeys';


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
 * Find all detail queries for a specific node UUID.
 */
export function findDetailCachesForNode(queryCache: QueryCache, nodeUuid: string): Query[] {
  return queryCache.findAll({ queryKey: nodeKeys.detailBase(nodeUuid) });
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
  return queryCache.findAll({ queryKey: nodeKeys.allPropertyBacklinks() });
}

// =============================================================================
// Internal Tree Traversal Helpers
// =============================================================================

function applyUpdateToNode(node: Node, targetUuid: string, updater: (node: Node) => Node): Node {
  if (node.uuid === targetUuid) {
    return updater(node);
  }
  if (node.children && node.children.length > 0) {
    const newChildren = node.children.map(child => applyUpdateToNode(child, targetUuid, updater));
    if (newChildren !== node.children) {
      return { ...node, children: newChildren };
    }
  }
  return node;
}

function removeNodeFromTree(node: Node, targetUuid: string): Node {
  if (node.children && node.children.length > 0) {
    const newChildren = node.children
      .filter(child => child.uuid !== targetUuid)
      .map(child => removeNodeFromTree(child, targetUuid));
    if (newChildren.length !== node.children.length) {
      return { ...node, children: newChildren };
    }
  }
  return node;
}

function insertChildIntoNode(node: Node, parentUuid: string, childNode: Node): Node {
  if (node.uuid === parentUuid) {
    const existing = node.children || [];
    if (existing.some(c => c.uuid === childNode.uuid)) return node;
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
      const updated = insertChildIntoNode(child, parentUuid, childNode);
      if (updated !== child) changed = true;
      return updated;
    });
    if (changed) return { ...node, children: newChildren };
  }
  return node;
}

function replaceNodeInTree(node: Node, oldUuid: string, newNode: Node): Node {
  if (node.children && node.children.length > 0) {
    const newChildren = node.children.map(child => {
      if (child.uuid === oldUuid) {
        // Preserve children from the optimistic node if the real node has none
        return { ...newNode, children: newNode.children?.length ? newNode.children : child.children };
      }
      return replaceNodeInTree(child, oldUuid, newNode);
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

function insertNodeAtParent(node: Node, nodeToInsert: Node, targetParentUuid: string, pos: number): Node {
  if (node.uuid === targetParentUuid) {
    const currentChildren = node.children || [];
    return { ...node, children: insertAtPosition(currentChildren, nodeToInsert, pos) };
  }
  if (node.children && node.children.length > 0) {
    return {
      ...node,
      children: node.children.map(child => insertNodeAtParent(child, nodeToInsert, targetParentUuid, pos)),
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
  nodeUuid: string,
  updater: (node: Node) => Node
): boolean {
  const queryCache = queryClient.getQueryCache();
  let modified = false;

  const applyToQuery = (query: Query) => {
    const oldData = query.state.data as Node | undefined;
    if (!oldData) return;
    const newData = applyUpdateToNode(oldData, nodeUuid, updater);
    if (newData !== oldData) {
      queryClient.setQueryData(query.queryKey, newData);
      modified = true;
    }
  };

  for (const query of findPageContentCaches(queryCache)) applyToQuery(query);
  for (const query of findUuidCaches(queryCache)) applyToQuery(query);
  for (const query of findDetailCachesForNode(queryCache, nodeUuid)) applyToQuery(query);

  return modified;
}

/**
 * Remove a node from all tree caches (detail, page-content, uuid).
 * Also removes the node from flat Node[] result caches.
 * Returns true if any cache was modified.
 */
export function removeNodeFromAllCaches(queryClient: QueryClient, nodeUuid: string): boolean {
  const queryCache = queryClient.getQueryCache();
  let modified = false;

  const removeFromTree = (query: Query) => {
    const oldData = query.state.data as Node | undefined;
    if (!oldData) return;
    const newData = removeNodeFromTree(oldData, nodeUuid);
    if (newData !== oldData) {
      queryClient.setQueryData(query.queryKey, newData);
      modified = true;
    }
  };

  for (const query of findPageContentCaches(queryCache)) removeFromTree(query);
  for (const query of findUuidCaches(queryCache)) removeFromTree(query);
  for (const query of findDetailCachesForNode(queryCache, nodeUuid)) removeFromTree(query);

  // Also remove from flat result caches
  for (const query of findFlatNodeCaches(queryCache)) {
    const oldData = query.state.data as Node[] | undefined;
    if (oldData && Array.isArray(oldData)) {
      const newData = oldData.filter(n => n.uuid !== nodeUuid);
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
  parentUuid: string,
  childNode: Node
): boolean {
  const queryCache = queryClient.getQueryCache();
  let modified = false;

  const applyToQuery = (query: Query) => {
    const oldData = query.state.data as Node | undefined;
    if (!oldData) return;
    const newData = insertChildIntoNode(oldData, parentUuid, childNode);
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
  oldUuid: string,
  newNode: Node
): boolean {
  const queryCache = queryClient.getQueryCache();
  let modified = false;

  const applyToQuery = (query: Query) => {
    const oldData = query.state.data as Node | undefined;
    if (!oldData) return;
    const newData = replaceNodeInTree(oldData, oldUuid, newNode);
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
  nodeUuid: string,
  newParentUuid: string | null,
  newSequence: number,
  movedNode: Node
): boolean {
  const queryCache = queryClient.getQueryCache();
  let modified = false;

  const updatedNode = { ...movedNode, parent_uuid: newParentUuid, sequence: newSequence };

  const applyToQuery = (query: Query) => {
    const oldData = query.state.data as Node | undefined;
    if (!oldData) return;

    // First remove from anywhere in the tree
    let result = removeNodeFromTree(oldData, nodeUuid);

    // Then insert at new parent if applicable
    if (newParentUuid !== null) {
      result = insertNodeAtParent(result, updatedNode, newParentUuid, newSequence);
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
  nodeUuid: string,
  updater: (node: Node) => Node
): boolean {
  const queryCache = queryClient.getQueryCache();
  let modified = false;

  for (const query of findFlatNodeCaches(queryCache)) {
    const oldData = query.state.data as Node[] | undefined;
    if (oldData && Array.isArray(oldData)) {
      let changed = false;
      const newData = oldData.map(n => {
        if (n.uuid === nodeUuid) {
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
export function removeNodeFromFlatCaches(queryClient: QueryClient, nodeUuid: string): boolean {
  const queryCache = queryClient.getQueryCache();
  let modified = false;

  for (const query of findFlatNodeCaches(queryCache)) {
    const oldData = query.state.data as Node[] | undefined;
    if (oldData && Array.isArray(oldData)) {
      const newData = oldData.filter(n => n.uuid !== nodeUuid);
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
  nodeUuid: string,
  updater: (node: Node) => Node
): boolean {
  const queryCache = queryClient.getQueryCache();
  let modified = false;

  for (const query of findListCaches(queryCache)) {
    const oldData = query.state.data as Node[] | undefined;
    if (oldData && Array.isArray(oldData)) {
      let changed = false;
      const newData = oldData.map(n => {
        if (n.uuid === nodeUuid) {
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
export function removeNodeFromLinkedRefCaches(queryClient: QueryClient, nodeUuid: string): boolean {
  const queryCache = queryClient.getQueryCache();
  let modified = false;

  for (const query of findLinkedRefCaches(queryCache)) {
    const oldData = query.state.data as { linked_references: LinkedReference[]; total_count: number } | undefined;
    if (oldData && oldData.linked_references) {
      const newRefs = oldData.linked_references.filter(ref => ref.source_node.uuid !== nodeUuid);
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
  nodeUuid: string
): boolean {
  const queryCache = queryClient.getQueryCache();
  let modified = false;

  for (const query of findPropertyBacklinkCaches(queryCache)) {
    const oldData = query.state.data as PropertyBacklink[] | undefined;
    if (oldData && Array.isArray(oldData)) {
      const newData = oldData.filter(ref => ref.source_page.uuid !== nodeUuid);
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
  | { type: 'update'; nodeUuid: string; updater: (node: Node) => Node }
  | { type: 'remove'; nodeUuid: string }
  | { type: 'insertChild'; parentUuid: string; childNode: Node }
  | { type: 'replace'; oldUuid: string; newNode: Node }
  | { type: 'move'; nodeUuid: string; newParentUuid: string | null; newSequence: number; movedNode: Node };

export function mutateNodeTree(
  queryClient: QueryClient,
  operation: CacheMutationOperation
): boolean {
  switch (operation.type) {
    case 'update':
      return updateNodeInTreeCaches(queryClient, operation.nodeUuid, operation.updater);
    case 'remove':
      return removeNodeFromAllCaches(queryClient, operation.nodeUuid);
    case 'insertChild':
      return insertChildIntoTreeCaches(queryClient, operation.parentUuid, operation.childNode);
    case 'replace':
      return replaceNodeInTreeCaches(queryClient, operation.oldUuid, operation.newNode);
    case 'move':
      return moveNodeInTreeCaches(
        queryClient,
        operation.nodeUuid,
        operation.newParentUuid,
        operation.newSequence,
        operation.movedNode
      );
    default:
      return false;
  }
}
