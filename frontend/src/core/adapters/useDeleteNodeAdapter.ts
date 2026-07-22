import { useContext } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import { WorkspaceStoreContext } from '../hooks/WorkspaceStoreContext';
import { getOrCreateWorkspaceStoreClient } from './workspaceStoreClientAdapter';

/**
 * Adapter hook that deletes a node through the async worker-backed store client.
 *
 * The SQLite path performs a hard delete, matching the current new-core behaviour.
 */
export function useDeleteNodeAdapter(): UseMutationResult<void, Error, string> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const ctx = useContext(WorkspaceStoreContext);

  return useMutation<void, Error, string>({
    mutationFn: async (nodeUuid) => {
      if (!ctx || !workspaceId) {
        throw new Error('Workspace not available for SQLite delete');
      }

      const client = await getOrCreateWorkspaceStoreClient(
        workspaceId,
        ctx.actorId,
        ctx.transport
      );

      await client.mutate<void>('deleteNode', [nodeUuid]);
    },
  });
}
