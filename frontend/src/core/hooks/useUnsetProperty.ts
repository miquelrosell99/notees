import { useContext } from 'react';
import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { getOrCreateWorkspaceStoreClient } from '../adapters/workspaceStoreClientAdapter';
import { WorkspaceStoreContext } from './WorkspaceStoreContext';
import { useUndoManager } from './useUndoManager';

export interface UnsetPropertyArgs {
  nodeId: string;
  schemaId: string;
  index?: number;
}

/**
 * Unset a property value on a node through the async worker-backed store client.
 * When an UndoManager facade is available the change is recorded for undo/redo.
 */
export function useUnsetProperty(): UseMutationResult<void, Error, UnsetPropertyArgs> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const ctx = useContext(WorkspaceStoreContext);
  const manager = useUndoManager(workspaceId ?? '');

  return useMutation<void, Error, UnsetPropertyArgs>({
    mutationFn: async (args) => {
      if (!ctx || !workspaceId) {
        throw new Error('Workspace store not available');
      }

      if (manager) {
        await manager.unsetProperty({
          nodeId: args.nodeId,
          schemaId: args.schemaId,
          index: args.index,
        });
        return;
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
