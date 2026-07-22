import { useContext, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import { WorkspaceStoreContext } from '../hooks/WorkspaceStoreContext';
import { getOrCreateWorkspaceStoreClient } from './workspaceStoreClientAdapter';
import { projectNodeFromClient } from './nodeProjection';

/**
 * Adapter hook that reads direct children through the async worker-backed store client.
 *
 * TODO: This uses `projectNodeFromClient`, which fetches the underlying sql.js
 * Database via `client.query('getDb')`. That works in the jsdom test shim but
 * cannot work in a real Web Worker. Replace with a worker-side projection query
 * before enabling the Web Worker path in production.
 */
export function useNodeChildrenAdapter(parentId: string | null): UseQueryResult<Node[], Error> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();

  const ctx = useContext(WorkspaceStoreContext);
  const [data, setData] = useState<Node[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!ctx || !workspaceId || !parentId) {
      setData([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    getOrCreateWorkspaceStoreClient(workspaceId, ctx.actorId, ctx.transport)
      .then(async (client) => {
        if (cancelled) return;

        const childIds = await client.query<string[]>('getChildren', [parentId]);
        if (cancelled) return;

        const nodes = (
          await Promise.all(
            childIds.map((childId) => projectNodeFromClient(client, childId, 1))
          )
        ).filter((n): n is Node => n !== undefined);
        if (cancelled) return;

        setData(nodes);
        setIsLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [ctx, workspaceId, parentId]);

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
