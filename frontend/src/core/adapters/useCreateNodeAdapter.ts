import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useContext } from 'react';
import type { Node, NodeCreate } from '@/types/api';
import { WorkspaceStoreContext } from '../hooks/WorkspaceStoreContext';
import { getOrCreateWorkspaceStore } from './workspaceStoreAdapter';
import { projectNode } from './nodeProjection';
import { uuidv7 } from '../uuid';

/**
 * Adapter hook that creates a node in the SQLite store.
 */
export function useCreateNodeAdapter(): UseMutationResult<Node, Error, NodeCreate> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const ctx = useContext(WorkspaceStoreContext);

  return useMutation<Node, Error, NodeCreate>({
    mutationFn: async (data) => {
      if (!ctx || !workspaceId) {
        throw new Error('Workspace not available for SQLite create');
      }

      const store = await getOrCreateWorkspaceStore(
        workspaceId,
        ctx.actorId,
        ctx.cryptoKey,
        ctx.transport
      );

      const nodeId = data.uuid ?? uuidv7();
      const kind: 'page' | 'block' | 'class' = data.parent_uuid ? 'block' : 'page';
      const classIds = data.class_uuids ?? [];

      store.createNode({
        nodeId,
        kind,
        parentId: data.parent_uuid ?? null,
        classIds,
      });

      // If an initial name was provided, set the text content.
      if (data.name) {
        store.updateText(nodeId, (text) => {
          const current = text.toPlaintext();
          text.delete(0, current.length);
          text.insert(0, data.name as string);
        });
      }

      const projected = projectNode(store, nodeId);
      if (!projected) {
        throw new Error('Failed to project created node');
      }
      return projected;
    },
  });
}
