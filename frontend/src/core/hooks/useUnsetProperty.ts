import { useContext } from 'react';
import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { getOrCreateWorkspaceStoreClient } from '../adapters/workspaceStoreClientAdapter';
import { WorkspaceStoreContext } from './WorkspaceStoreContext';

export interface UnsetPropertyArgs {
  nodeId: string;
  schemaId: string;
  index?: number;
}

/**
 * Unset a property value on a node through the async worker-backed store client.
 *
 * TODO: Re-integrate UndoManager once it supports the async client. Until then
 * this mutation writes directly to the store without an undo entry.
 */
export function useUnsetProperty(): UseMutationResult<void, Error, UnsetPropertyArgs> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const ctx = useContext(WorkspaceStoreContext);

  return useMutation<void, Error, UnsetPropertyArgs>({
    mutationFn: async (args) => {
      if (!ctx || !workspaceId) {
        throw new Error('Workspace store not available');
      }
      const client = await getOrCreateWorkspaceStoreClient(
        workspaceId,
        ctx.actorId,
        ctx.transport
      );
      await client.mutate<void>('unsetProperty', [args]);
    },
  });
}
