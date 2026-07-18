import { useContext } from 'react';
import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { getOrCreateWorkspaceStore } from '../adapters/workspaceStoreAdapter';
import { WorkspaceStoreContext } from './WorkspaceStoreContext';

export interface UnsetPropertyArgs {
  nodeId: string;
  schemaId: string;
  index?: number;
}

/**
 * Unset a property value on a node in the SQLite store.
 */
export function useUnsetProperty(): UseMutationResult<void, Error, UnsetPropertyArgs> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const ctx = useContext(WorkspaceStoreContext);

  return useMutation<void, Error, UnsetPropertyArgs>({
    mutationFn: async (args) => {
      if (!ctx || !workspaceId) {
        throw new Error('Workspace store not available');
      }
      const store = await getOrCreateWorkspaceStore(
        workspaceId,
        ctx.actorId,
        ctx.cryptoKey,
        ctx.transport
      );
      store.unsetProperty(args);
    },
  });
}
