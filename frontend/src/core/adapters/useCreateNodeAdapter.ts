import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useContext } from 'react';
import type { Node, NodeCreate } from '@/types/api';
import { SYSTEM_CLASS_UUIDS } from '@/constants';
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
      const classClassUuid = SYSTEM_CLASS_UUIDS.class;
      const rawClassIds = data.class_uuids ?? [];
      const isClass = rawClassIds.includes(classClassUuid);
      const kind: 'page' | 'block' | 'class' = data.parent_uuid
        ? 'block'
        : isClass
          ? 'class'
          : 'page';
      // The class system class is redundant once kind='class' is the source of
      // truth; strip it so class nodes are not self-referential members of Class.
      const classIds = rawClassIds.filter((id) => id !== classClassUuid);

      await client.mutate<void>('createNode', [
        {
          nodeId,
          kind,
          parentId: data.parent_uuid ?? null,
          classIds,
        },
      ]);

      // If an initial name was provided, set the text content.
      if (data.name) {
        await client.mutate<void>('setNodeText', [nodeId, data.name as string]);
      }

      const projected = await projectNodeFromClient(client, nodeId);
      if (!projected) {
        throw new Error('Failed to project created node');
      }
      return projected;
    },
  });
}
