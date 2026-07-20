import { useContext } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import { WorkspaceStoreContext } from '../hooks/WorkspaceStoreContext';
import { getOrCreateWorkspaceStore } from './workspaceStoreAdapter';
import { projectNode } from './nodeProjection';

/**
 * Adapter hook that moves a node in the SQLite store.
 *
 * Position is out of scope for the prototype: the node is always appended to
 * the end of the target parent's children.
 */
export function useMoveNodeAdapter(): UseMutationResult<
  Node,
  Error,
  { nodeUuid: string; parentId: string | null; position?: number }
> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const ctx = useContext(WorkspaceStoreContext);

  return useMutation<
    Node,
    Error,
    { nodeUuid: string; parentId: string | null; position?: number }
  >({
    mutationFn: async ({ nodeUuid, parentId, position }) => {
      if (!ctx || !workspaceId) {
        throw new Error('Workspace not available for SQLite move');
      }

      const store = await getOrCreateWorkspaceStore(
        workspaceId,
        ctx.actorId,
        ctx.transport
      );

      if (position !== undefined) {
        // TODO(D2): Positioned insertion is not supported in the prototype slice.
        console.warn(
          '[useMoveNodeAdapter] explicit position not yet supported in SQLite store; inserting at end'
        );
      }

      store.moveNode(nodeUuid, parentId);

      const projected = projectNode(store, nodeUuid);
      if (!projected) {
        throw new Error('Node not found after SQLite move');
      }
      return projected;
    },
  });
}
