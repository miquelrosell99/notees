import { useContext, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import { WorkspaceStoreContext } from '../hooks/WorkspaceStoreContext';
import { getOrCreateWorkspaceStoreClient } from './workspaceStoreClientAdapter';
import type { IWorkspaceStoreClient } from '../worker/workerProtocol';

export interface UseNodesAdapterFilters {
  pages_only?: boolean;
  parent_uuid?: string;
  tag_uuid?: string;
  page_size?: number;
}

/**
 * Adapter hook that lists nodes through the async worker-backed store client.
 *
 * The actual query runs inside the worker via `listNodes`; the raw sql.js
 * Database is never transferred to the main thread.
 */
export function useNodesAdapter(
  filters?: UseNodesAdapterFilters | null
): UseQueryResult<Node[], Error> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();

  const ctx = useContext(WorkspaceStoreContext);
  const [data, setData] = useState<Node[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!ctx || !workspaceId) {
      setData([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    const effectWorkspaceId = workspaceId;
    const effectCtx = ctx;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    setIsLoading(true);
    setError(null);

    async function fetchNodes(client?: IWorkspaceStoreClient) {
      if (cancelled) return;
      setIsLoading(true);
      setError(null);
      try {
        const c =
          client ??
          (await getOrCreateWorkspaceStoreClient(
            effectWorkspaceId,
            effectCtx.actorId,
            effectCtx.transport
          ));
        if (cancelled) return;
        if (!unsubscribe) {
          unsubscribe = c.subscribe(null, () => {
            if (!c.isClosed() && !cancelled) {
              void fetchNodes(c);
            }
          });
        }
        const nodes = await c.query<Node[]>('listNodes', [filters]);
        if (cancelled) return;

        setData(nodes);
        setIsLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setIsLoading(false);
      }
    }

    void fetchNodes();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    ctx,
    workspaceId,
    filters?.pages_only,
    filters?.parent_uuid,
    filters?.tag_uuid,
    filters?.page_size,
  ]);

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
