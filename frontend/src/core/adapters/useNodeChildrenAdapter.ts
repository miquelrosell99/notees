import { useContext, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import { useNodeChildrenLegacy } from '@/features/content/hooks/useNodeBasicQueries';
import type { Node } from '@/types/api';
import { WorkspaceStoreContext } from '../hooks/WorkspaceStoreContext';
import { getOrCreateWorkspaceStore } from './workspaceStoreAdapter';
import { projectNode } from './nodeProjection';
import { ENABLE_SQLITE_STORE } from '../utils/featureFlags';

/**
 * Adapter hook that reads direct children from the SQLite store when
 * ENABLE_SQLITE_STORE is on, otherwise delegates to the legacy hook.
 */
export function useNodeChildrenAdapter(parentId: string | null): UseQueryResult<Node[], Error> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const legacyResult = useNodeChildrenLegacy(parentId);

  const ctx = useContext(WorkspaceStoreContext);
  const [data, setData] = useState<Node[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!ENABLE_SQLITE_STORE || !ctx || !workspaceId || !parentId) {
      setData([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    setIsLoading(true);
    setError(null);

    getOrCreateWorkspaceStore(workspaceId, ctx.actorId, ctx.cryptoKey, ctx.transport)
      .then((store) => {
        if (cancelled) return;

        const update = (): void => {
          if (cancelled) return;
          const childIds = store.getChildren(parentId);
          const nodes = childIds
            .map((childId) => projectNode(store, childId, 1))
            .filter((n): n is Node => n !== undefined);
          setData(nodes);
        };
        update();
        setIsLoading(false);
        unsubscribe = store.subscribe(parentId, update);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [ctx, workspaceId, parentId]);

  if (!ENABLE_SQLITE_STORE) {
    return legacyResult as UseQueryResult<Node[], Error>;
  }

  const isPending = isLoading;
  const isSuccess = !isLoading && !error;
  const isErrorState = error !== null;
  const status: UseQueryResult<Node[], Error>['status'] = isLoading
    ? 'pending'
    : isErrorState
      ? 'error'
      : 'success';

  return {
    data,
    isLoading,
    isError: isErrorState,
    error,
    isPending,
    isSuccess,
    status,
    fetchStatus: 'idle',
  } as unknown as UseQueryResult<Node[], Error>;
}
