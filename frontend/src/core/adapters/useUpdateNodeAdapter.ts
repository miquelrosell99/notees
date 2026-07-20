import { useContext } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import type { Node, NodeUpdate } from '@/types/api';
import { WorkspaceStoreContext } from '../hooks/WorkspaceStoreContext';
import { getOrCreateWorkspaceStore } from './workspaceStoreAdapter';
import { projectNode } from './nodeProjection';

/**
 * Adapter hook that updates a node in the SQLite store.
 */
export function useUpdateNodeAdapter(): UseMutationResult<
  Node,
  Error,
  { nodeUuid: string; data: NodeUpdate }
> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const ctx = useContext(WorkspaceStoreContext);

  return useMutation<Node, Error, { nodeUuid: string; data: NodeUpdate }>({
    mutationFn: async ({ nodeUuid, data }) => {
      if (!ctx || !workspaceId) {
        throw new Error('Workspace not available for SQLite update');
      }

      const store = await getOrCreateWorkspaceStore(
        workspaceId,
        ctx.actorId,
        ctx.transport
      );

      if (data.name !== undefined && data.name !== null) {
        const nameValue = data.name as string;
        let parsedAst: unknown[] | null = null;
        try {
          const parsed = JSON.parse(nameValue);
          if (Array.isArray(parsed)) {
            parsedAst = parsed;
          }
        } catch {
          // Not JSON; treat as plain text below.
        }

        if (parsedAst) {
          store.updateContentAst(nodeUuid, parsedAst);
        } else {
          store.updateText(nodeUuid, (text) => {
            const current = text.toPlaintext();
            text.delete(0, current.length);
            text.insert(0, nameValue);
          });
        }
      }

      if (data.is_page !== undefined) {
        // TODO(D2): Apply class assignment/unassignment once the page system
        // class UUID is exposed by the new core.
        console.warn('[useUpdateNodeAdapter] is_page toggle not yet supported in SQLite store');
      }

      if (data.icon !== undefined || data.color !== undefined) {
        // TODO(D2): Persist icon/color when the new core supports metadata fields.
        console.warn('[useUpdateNodeAdapter] icon/color updates not yet supported in SQLite store');
      }

      const projected = projectNode(store, nodeUuid);
      if (!projected) {
        throw new Error('Node not found after SQLite update');
      }
      return projected;
    },
  });
}
