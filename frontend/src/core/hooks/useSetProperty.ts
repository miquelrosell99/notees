import { useContext } from 'react';
import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { getOrCreateWorkspaceStoreClient } from '../adapters/workspaceStoreClientAdapter';
import { WorkspaceStoreContext } from './WorkspaceStoreContext';
import { useUndoManager } from './useUndoManager';
import { uuidv7 } from '../uuid';

export interface SetPropertyArgs {
  nodeId: string;
  schemaId: string;
  value: unknown;
  index?: number;
}

/**
 * Set a property value on a node through the async worker-backed store client.
 * When an UndoManager facade is available the change is recorded for undo/redo.
 */
export function useSetProperty(): UseMutationResult<void, Error, SetPropertyArgs> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const ctx = useContext(WorkspaceStoreContext);
  const manager = useUndoManager(workspaceId ?? '');

  return useMutation<void, Error, SetPropertyArgs>({
    mutationFn: async (args) => {
      if (!ctx || !workspaceId) {
        throw new Error('Workspace store not available');
      }

      if (manager) {
        await manager.setProperty({
          propertyValueId: uuidv7(),
          nodeId: args.nodeId,
          schemaId: args.schemaId,
          index: args.index,
          value: args.value,
        });
        return;
      }

      const client = await getOrCreateWorkspaceStoreClient(
        workspaceId,
        ctx.actorId,
        ctx.transport
      );
      await client.mutate<void>('setProperty', [
        {
          propertyValueId: uuidv7(),
          nodeId: args.nodeId,
          schemaId: args.schemaId,
          index: args.index,
          value: args.value,
        },
      ]);
    },
  });
}
