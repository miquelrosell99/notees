import { useContext, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import { WorkspaceStoreContext } from '../hooks/WorkspaceStoreContext';
import { getOrCreateWorkspaceStoreClient } from './workspaceStoreClientAdapter';
import { projectNodeFromClient } from './nodeProjection';
import type { IWorkspaceStoreClient } from '../worker/workerProtocol';

/**
 * Adapter hook that reads direct children through the async worker-backed store client.
 *
 * Projection runs inside the worker via `getChildren` and `projectNode`; the raw
 * sql.js Database is never transferred to the main thread.
 */
export function useNodeChildrenAdapter(parentId: string | null): UseQueryResult<Node[], Error> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();

  const ctx = useContext(WorkspaceStoreContext);
  const [data, setData] = useState<Node[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const hasDataRef = useRef(false);

  useEffect(() => {
    if (!ctx || !workspaceId || !parentId) {
      setData([]);
      setIsLoading(false);
      setError(null);
      hasDataRef.current = false;
      return;
    }

    const effectWorkspaceId = workspaceId;
    const effectCtx = ctx;
    const effectParentId = parentId;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    if (!hasDataRef.current) {
      setIsLoading(true);
    }
    setError(null);

    async function fetchChildren(client?: IWorkspaceStoreClient) {
      if (cancelled) return;
      if (!hasDataRef.current) {
        setIsLoading(true);
      }
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
              void fetchChildren(c);
            }
          });
        }
        const childIds = await c.query<string[]>('getChildren', [effectParentId]);
        if (cancelled) return;

        const nodes = (
          await Promise.all(
            childIds.map((childId) => projectNodeFromClient(c, childId, 1))
          )
        ).filter((n): n is Node => n !== undefined);
        if (cancelled) return;

        setData(nodes);
        hasDataRef.current = true;
        setIsLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        if (!hasDataRef.current) {
          setIsLoading(false);
        }
      }
    }

    void fetchChildren();

    return () => {
      cancelled = true;
      unsubscribe?.();
      hasDataRef.current = false;
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
