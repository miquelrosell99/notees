import { useContext } from 'react';
import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { getOrCreateWorkspaceStore } from '../adapters/workspaceStoreAdapter';
import { WorkspaceStoreContext } from './WorkspaceStoreContext';
import { uuidv7 } from '../uuid';
import { UndoManager } from '../undo';

export interface SetPropertyArgs {
  nodeId: string;
  schemaId: string;
  value: unknown;
  index?: number;
}

/**
 * Set a property value on a node in the SQLite store.
 */
export function useSetProperty(): UseMutationResult<void, Error, SetPropertyArgs> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const ctx = useContext(WorkspaceStoreContext);

  return useMutation<void, Error, SetPropertyArgs>({
    mutationFn: async (args) => {
      if (!ctx || !workspaceId) {
        throw new Error('Workspace store not available');
      }
      const store = await getOrCreateWorkspaceStore(
        workspaceId,
        ctx.actorId,
        ctx.transport
      );
      const manager = UndoManager.getOrCreateUndoManager(workspaceId, store);
      manager.setProperty({
        propertyValueId: uuidv7(),
        nodeId: args.nodeId,
        schemaId: args.schemaId,
        index: args.index,
        value: args.value,
      });
    },
  });
}
