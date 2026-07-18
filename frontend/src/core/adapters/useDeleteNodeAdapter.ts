import { useContext } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import { useDeleteNodeLegacy } from '@/features/content/hooks/useDeleteNode';
import { WorkspaceStoreContext } from '../hooks/WorkspaceStoreContext';
import { getOrCreateWorkspaceStore } from './workspaceStoreAdapter';
import { ENABLE_SQLITE_STORE } from '../utils/featureFlags';

/**
 * Adapter hook that deletes a node from the SQLite store when ENABLE_SQLITE_STORE
 * is on, otherwise delegates to the legacy hook.
 *
 * The SQLite path performs a hard delete, matching the current new-core behaviour.
 */
export function useDeleteNodeAdapter(): UseMutationResult<void, Error, string> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const ctx = useContext(WorkspaceStoreContext);
  const legacyResult = useDeleteNodeLegacy();

  const sqliteResult = useMutation<void, Error, string>({
    mutationFn: async (nodeUuid) => {
      if (!ctx || !workspaceId) {
        throw new Error('Workspace not available for SQLite delete');
      }

      const store = await getOrCreateWorkspaceStore(
        workspaceId,
        ctx.actorId,
        ctx.cryptoKey,
        ctx.transport
      );

      store.deleteNode(nodeUuid);
    },
  });

  if (!ENABLE_SQLITE_STORE) {
    return legacyResult as unknown as UseMutationResult<void, Error, string>;
  }
  return sqliteResult;
}
