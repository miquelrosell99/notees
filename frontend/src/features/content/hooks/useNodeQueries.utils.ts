/**
 * useNodeQueries utilities
 */

import type { Node } from '@/types/api';

export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Recursively search a node tree for a node by ID.
 * Returns the matching node or undefined.
 */
export function findNodeInTree(root: Node, targetId: string): Node | undefined {
  if (root.uuid === targetId) return root;
  if (root.children) {
    for (const child of root.children) {
      const found = findNodeInTree(child, targetId);
      if (found) return found;
    }
  }
  return undefined;
}

export function findNodeInTreeByUuid(root: Node, targetUuid: string): Node | undefined {
  if (root.uuid === targetUuid) return root;
  if (root.children) {
    for (const child of root.children) {
      const found = findNodeInTreeByUuid(child, targetUuid);
      if (found) return found;
    }
  }
  return undefined;
}

// ==================== Node Queries ====================

/**
 * Hook to fetch all nodes
 * Pass undefined to disable the query (useful for conditional fetching)
 */
