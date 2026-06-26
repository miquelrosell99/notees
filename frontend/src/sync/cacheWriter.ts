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
  | 'parent_uuid'
  | 'sequence'
  | 'collapsed'
  | 'classes_uuid'
  | 'tags_uuid'
  | 'properties_uuid'
  | 'is_private'
  | 'is_page'
  | 'is_class'
  | 'is_daily'
  | 'is_monthly'
  | 'is_yearly'
>>;

/**
 * Insert a newly created child under its parent in all tree caches.
 */
export function writeCreate(queryClient: QueryClient, parentUuid: string, childNode: Node): void {
  insertChildIntoTreeCaches(queryClient, parentUuid, childNode);
}

/**
 * Patch fields of an existing node everywhere it appears in caches.
 */
export function writeUpdate(queryClient: QueryClient, nodeUuid: string, patch: NodePatch): void {
  const updater = (node: Node): Node => ({ ...node, ...patch });
  updateNodeInTreeCaches(queryClient, nodeUuid, updater);
  updateNodeInFlatCaches(queryClient, nodeUuid, updater);
}

/**
 * Remove a node from all caches (optimistic delete).
 */
export function writeDelete(queryClient: QueryClient, nodeUuid: string): void {
  removeNodeFromAllCaches(queryClient, nodeUuid);
}

/**
 * Move a node to a new parent/sequence across all tree caches.
 */
export function writeMove(
  queryClient: QueryClient,
  nodeUuid: string,
  newParentUuid: string | null,
  newSequence: number,
  movedNode: Node,
): void {
  moveNodeInTreeCaches(queryClient, nodeUuid, newParentUuid, newSequence, movedNode);
}
