import { useContext, useEffect, useState } from 'react';
import { useNavigate, useParams, type NavigateOptions } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import { WorkspaceStoreContext } from '../hooks/WorkspaceStoreContext';
import { getOrCreateWorkspaceStore } from './workspaceStoreAdapter';
import { projectNode } from './nodeProjection';

const NOT_FOUND_REDIRECT_DELAY_MS = 100;

export interface UseNodeAdapterOptions {
  include_children?: boolean;
  include_backlinks?: boolean;
  include_properties?: boolean;
  meta?: Record<string, unknown>;
  staleTime?: number;
}

/**
 * Adapter hook that reads a single node from the SQLite core store.
 *
 * Mirrors the legacy 404 behaviour: if the node disappears or is not found,
 * navigate away from it after a short delay.
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

  useEffect(() => {
    if (!ctx || !workspaceId || !id) {
      setData(undefined);
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
          setData(projectNode(store, id));
        };
        update();
        setIsLoading(false);
        unsubscribe = store.subscribe(id, update);
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
  }, [ctx, workspaceId, id]);

  useEffect(() => {
    if (!isLoading && data === undefined && id) {
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
  }, [isLoading, data, id, navigate, workspaceId]);

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
