/**
 * Node Tree Utilities
 * 
 * Common tree traversal and manipulation functions for node hierarchies.
 * Consolidates duplicate implementations from NodeListView, NodeDocumentView, etc.
 */
import type { Node } from '@/types';

/**
 * Find a node by ID in a tree structure (recursive depth-first search)
 * 
 * @param id - The node ID to find
 * @param nodes - Array of nodes to search (including children)
 * @returns The found node or null
 */
export function findNodeById(id: number, nodes: Node[]): Node | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children && node.children.length > 0) {
      const found = findNodeById(id, node.children);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Find a node by UUID in a tree structure
 * 
 * @param uuid - The node UUID to find
 * @param nodes - Array of nodes to search (including children)
 * @returns The found node or null
 */
export function findNodeByUuid(uuid: string, nodes: Node[]): Node | null {
  for (const node of nodes) {
    if (node.uuid === uuid) return node;
    if (node.children && node.children.length > 0) {
      const found = findNodeByUuid(uuid, node.children);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Find a node in a tree using a predicate function
 * 
 * @param predicate - Function that returns true for the target node
 * @param nodes - Array of nodes to search (including children)
 * @returns The found node or null
 */
export function findNodeInTree(
  predicate: (node: Node) => boolean,
  nodes: Node[]
): Node | null {
  for (const node of nodes) {
    if (predicate(node)) return node;
    if (node.children && node.children.length > 0) {
      const found = findNodeInTree(predicate, node.children);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Update a node in a tree structure immutably
 * 
 * @param nodes - Array of nodes to update
 * @param targetId - ID of the node to update
 * @param updater - Function to transform the node
 * @returns New array with the updated node
 */
export function updateNodeInTree(
  nodes: Node[],
  targetId: number,
  updater: (node: Node) => Node
): Node[] {
  return nodes.map(node => {
    if (node.id === targetId) {
      return updater(node);
    }
    if (node.children && node.children.length > 0) {
      return {
        ...node,
        children: updateNodeInTree(node.children, targetId, updater),
      };
    }
    return node;
  });
}

/**
 * Remove a node from a tree structure immutably
 * 
 * @param nodes - Array of nodes
 * @param targetId - ID of the node to remove
 * @returns New array without the target node
 */
export function removeNodeFromTree(nodes: Node[], targetId: number): Node[] {
  return nodes
    .filter(node => node.id !== targetId)
    .map(node => {
      if (node.children && node.children.length > 0) {
        return {
          ...node,
          children: removeNodeFromTree(node.children, targetId),
        };
      }
      return node;
    });
}

/**
 * Map over all nodes in a tree (depth-first)
 * 
 * @param nodes - Array of nodes
 * @param mapper - Function to transform each node
 * @returns Flattened array of mapped values
 */
export function mapNodeTree<T>(
  nodes: Node[],
  mapper: (node: Node, depth: number) => T,
  depth: number = 0
): T[] {
  const results: T[] = [];
  for (const node of nodes) {
    results.push(mapper(node, depth));
    if (node.children && node.children.length > 0) {
      results.push(...mapNodeTree(node.children, mapper, depth + 1));
    }
  }
  return results;
}

/**
 * Flatten a tree of nodes into a single array
 * 
 * @param nodes - Array of nodes with potential children
 * @returns Flat array of all nodes
 */
export function flattenNodeTree(nodes: Node[]): Node[] {
  const result: Node[] = [];
  for (const node of nodes) {
    result.push(node);
    if (node.children && node.children.length > 0) {
      result.push(...flattenNodeTree(node.children));
    }
  }
  return result;
}

/**
 * Get all node IDs in a tree
 * 
 * @param nodes - Array of nodes
 * @returns Array of all node IDs
 */
export function getAllNodeIds(nodes: Node[]): number[] {
  return mapNodeTree(nodes, (node) => node.id);
}

/**
 * Count all nodes in a tree (including children)
 * 
 * @param nodes - Array of nodes
 * @returns Total count of nodes
 */
export function countNodes(nodes: Node[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (node.children && node.children.length > 0) {
      count += countNodes(node.children);
    }
  }
  return count;
}

/**
 * Get the depth of a node in a tree (0 if at root)
 * 
 * @param targetId - ID of the node to find
 * @param nodes - Root nodes to search
 * @param currentDepth - Internal tracking parameter
 * @returns Depth of the node, or -1 if not found
 */
export function getNodeDepth(
  targetId: number,
  nodes: Node[],
  currentDepth: number = 0
): number {
  for (const node of nodes) {
    if (node.id === targetId) return currentDepth;
    if (node.children && node.children.length > 0) {
      const depth = getNodeDepth(targetId, node.children, currentDepth + 1);
      if (depth !== -1) return depth;
    }
  }
  return -1;
}

// ==================== Reference-Equality Optimized Variants ====================
// These variants return the same reference when nothing changed, which is critical
// for optimistic cache updates to avoid unnecessary React re-renders.

/**
 * Update a node in a tree by ID using an updater function.
 * Returns the same array reference if nothing changed.
 * Operates on a single root node (for detail cache entries).
 */
export function updateNodeByIdImmutable(
  node: Node | undefined,
  targetId: number,
  updater: (n: Node) => Node
): Node | undefined {
  if (!node) return undefined;
  if (node.id === targetId) {
    return updater(node);
  }
  if (node.children && node.children.length > 0) {
    const newChildren = node.children
      .map(child => updateNodeByIdImmutable(child, targetId, updater))
      .filter((n): n is Node => n !== undefined);
    const childrenChanged = newChildren.some((child, i) => child !== node.children![i]);
    if (childrenChanged) {
      return { ...node, children: newChildren };
    }
  }
  return node;
}

/**
 * Update a node in a tree with partial updates.
 * Returns the same array reference if nothing changed.
 */
export function updateNodeInTreeImmutable(
  nodes: Node[],
  nodeId: number,
  updates: Partial<Node>
): Node[] {
  let changed = false;
  const result = nodes.map(node => {
    if (node.id === nodeId) {
      changed = true;
      return { ...node, ...updates };
    }
    if (node.children && node.children.length > 0) {
      const newChildren = updateNodeInTreeImmutable(node.children, nodeId, updates);
      if (newChildren !== node.children) {
        changed = true;
        return { ...node, children: newChildren };
      }
    }
    return node;
  });
  return changed ? result : nodes;
}

/**
 * Remove a node from a tree structure.
 * Returns the same array reference if nothing was removed.
 */
export function removeNodeFromTreeImmutable(nodes: Node[], nodeId: number): Node[] {
  const directRemoval = nodes.some(node => node.id === nodeId);

  let childrenChanged = false;
  const mappedNodes = nodes.map(node => {
    if (node.id === nodeId) {
      return node; // Will be filtered out below
    }
    if (node.children && node.children.length > 0) {
      const newChildren = removeNodeFromTreeImmutable(node.children, nodeId);
      if (newChildren !== node.children) {
        childrenChanged = true;
        return { ...node, children: newChildren };
      }
    }
    return node;
  });

  if (directRemoval) {
    return mappedNodes.filter(node => node.id !== nodeId);
  }
  return childrenChanged ? mappedNodes : nodes;
}

/**
 * Find a node by ID in a single root node's tree (DFS).
 * Useful for searching within a detail cache entry.
 */
export function findNodeInRootTree(root: Node, nodeId: number): Node | null {
  if (root.id === nodeId) return root;
  if (root.children) {
    for (const child of root.children) {
      const found = findNodeInRootTree(child, nodeId);
      if (found) return found;
    }
  }
  return null;
}
