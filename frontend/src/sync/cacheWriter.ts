/**
 * cacheWriter — targeted TanStack Query updates for the sync layer.
 *
 * This is the only module that writes to node caches on behalf of local
 * mutations. It wraps the lower-level cacheUtils helpers with an
 * operation-friendly API.
 */

import type { QueryClient } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import {
  insertChildIntoTreeCaches,
  updateNodeInTreeCaches,
  updateNodeInFlatCaches,
  removeNodeFromAllCaches,
  moveNodeInTreeCaches,
} from '@/hooks/cacheUtils';

export type NodePatch = Partial<Pick<
  Node,
  | 'name'
  | 'icon'
  | 'color'
  | 'parent_id'
  | 'sequence'
  | 'collapsed'
  | 'classes'
  | 'tags'
  | 'properties'
  | 'is_private'
>>;

/**
 * Insert a newly created child under its parent in all tree caches.
 */
export function writeCreate(queryClient: QueryClient, parentId: number, childNode: Node): void {
  insertChildIntoTreeCaches(queryClient, parentId, childNode);
}

/**
 * Patch fields of an existing node everywhere it appears in caches.
 */
export function writeUpdate(queryClient: QueryClient, nodeId: number, patch: NodePatch): void {
  const updater = (node: Node): Node => ({ ...node, ...patch });
  updateNodeInTreeCaches(queryClient, nodeId, updater);
  updateNodeInFlatCaches(queryClient, nodeId, updater);
}

/**
 * Remove a node from all caches (optimistic delete).
 */
export function writeDelete(queryClient: QueryClient, nodeId: number): void {
  removeNodeFromAllCaches(queryClient, nodeId);
}

/**
 * Move a node to a new parent/sequence across all tree caches.
 */
export function writeMove(
  queryClient: QueryClient,
  nodeId: number,
  newParentId: number | null,
  newSequence: number,
  movedNode: Node,
): void {
  moveNodeInTreeCaches(queryClient, nodeId, newParentId, newSequence, movedNode);
}
