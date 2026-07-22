import { useContext } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import { WorkspaceStoreContext } from '../hooks/WorkspaceStoreContext';
import { getOrCreateWorkspaceStoreClient } from './workspaceStoreClientAdapter';
import { projectNodeFromClient } from './nodeProjection';

/**
 * Adapter hook that moves a node through the async worker-backed store client.
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

      const client = await getOrCreateWorkspaceStoreClient(
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

      await client.mutate<void>('moveNode', [nodeUuid, parentId]);

      const projected = await projectNodeFromClient(client, nodeUuid);
      if (!projected) {
        throw new Error('Node not found after SQLite move');
      }
      return projected;
    },
  });
}
