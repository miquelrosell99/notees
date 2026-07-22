import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useContext } from 'react';
import type { Node, NodeCreate } from '@/types/api';
import type { TextCrdt } from '../crdt/text';
import { WorkspaceStoreContext } from '../hooks/WorkspaceStoreContext';
import { getOrCreateWorkspaceStoreClient } from './workspaceStoreClientAdapter';
import { projectNodeFromClient } from './nodeProjection';
import { uuidv7 } from '../uuid';

/**
 * Adapter hook that creates a node through the async worker-backed store client.
 */
export function useCreateNodeAdapter(): UseMutationResult<Node, Error, NodeCreate> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const ctx = useContext(WorkspaceStoreContext);

  return useMutation<Node, Error, NodeCreate>({
    mutationFn: async (data) => {
      if (!ctx || !workspaceId) {
        throw new Error('Workspace not available for SQLite create');
      }

      const client = await getOrCreateWorkspaceStoreClient(
        workspaceId,
        ctx.actorId,
        ctx.transport
      );

      const nodeId = data.uuid ?? uuidv7();
      const kind: 'page' | 'block' | 'class' = data.parent_uuid ? 'block' : 'page';
      const classIds = data.class_uuids ?? [];

      await client.mutate<void>('createNode', [
        {
          nodeId,
          kind,
          parentId: data.parent_uuid ?? null,
          classIds,
        },
      ]);

      // If an initial name was provided, set the text content.
      // TODO: Passing a callback through the worker will not work in a real
      // browser because functions are not structured-clonable. Replace with a
      // serializable updateText variant (e.g. replace/range operations) before
      // enabling the Web Worker path.
      if (data.name) {
        await client.mutate<void>('updateText', [
          nodeId,
          (text: TextCrdt) => {
            const current = text.toPlaintext();
            text.delete(0, current.length);
            text.insert(0, data.name as string);
          },
        ]);
      }

      const projected = await projectNodeFromClient(client, nodeId);
      if (!projected) {
        throw new Error('Failed to project created node');
      }
      return projected;
    },
  });
}
