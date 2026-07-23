import { useContext, useEffect, useState } from 'react';
import { useNavigate, useParams, type NavigateOptions } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import { WorkspaceStoreContext } from '../hooks/WorkspaceStoreContext';
import { getOrCreateWorkspaceStoreClient } from './workspaceStoreClientAdapter';
import { projectNodeFromClient } from './nodeProjection';
import type { IWorkspaceStoreClient } from '../worker/workerProtocol';
import { useSyncStatusStore } from '@/features/sync';

const NOT_FOUND_REDIRECT_DELAY_MS = 1_500;

export interface UseNodeAdapterOptions {
  include_children?: boolean;
  include_backlinks?: boolean;
  include_properties?: boolean;
  meta?: Record<string, unknown>;
  staleTime?: number;
}

/**
 * Adapter hook that reads a single node through the async worker-backed store client.
 *
 * Mirrors the legacy 404 behaviour: if the node disappears or is not found,
 * navigate away from it after a short delay.
 *
 * Projection runs inside the worker via `projectNode`; the raw sql.js Database
 * is never transferred to the main thread.
 */
export function useNodeAdapter(
  id: string | null,
  _options?: UseNodeAdapterOptions
): UseQueryResult<Node, Error> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const navigate = useNavigate();

  const ctx = useContext(WorkspaceStoreContext);
  const [data, setData] = useState<Node | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const syncStatus = useSyncStatusStore((s) => s.status);

  useEffect(() => {
    if (!ctx || !workspaceId || !id) {
      setData(undefined);
      setIsLoading(false);
      setError(null);
      return;
    }

    const effectWorkspaceId = workspaceId;
    const effectCtx = ctx;
    const effectId = id;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    setIsLoading(true);
    setError(null);

    async function fetchNode(client?: IWorkspaceStoreClient) {
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
              void fetchNode(c);
            }
          });
        }
        const node = await projectNodeFromClient(c, effectId);
        if (cancelled) return;
        setData(node);
        setIsLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setIsLoading(false);
      }
    }

    void fetchNode();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [ctx, workspaceId, id]);

  useEffect(() => {
    if (!isLoading && data === undefined && id) {
      // Only redirect once we have given sync a chance to populate the node.
      // If sync is still in progress, the consumer can render a "not found"
      // placeholder and this effect will re-evaluate when the status changes.
      const canRedirect = syncStatus === 'synced' || syncStatus === 'error';
      if (!canRedirect) return;

      const timer = setTimeout(() => {
        void import('@/stores').then(({ useNavigationStore }) => {
          const currentNodeUuid = useNavigationStore.getState().currentNodeUuid;
          if (currentNodeUuid === id) {
            useNavigationStore.setState({
              currentNodeUuid: null,
              mainViewType: 'node',
            });
            navigate(workspaceId ? `/${workspaceId}` : '/', { replace: true } as NavigateOptions);
          }
        });
      }, NOT_FOUND_REDIRECT_DELAY_MS);
      return () => clearTimeout(timer);
    }
  }, [isLoading, data, id, syncStatus, navigate, workspaceId]);

  const isPending = isLoading;
  const isSuccess = !isLoading && !error && data !== undefined;
  const isErrorState = error !== null;
  const status: UseQueryResult<Node, Error>['status'] = isLoading
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
  } as unknown as UseQueryResult<Node, Error>;
}
