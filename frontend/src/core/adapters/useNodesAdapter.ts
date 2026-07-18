import { useContext, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import { useNodesLegacy } from '@/features/content/hooks/useNodeBasicQueries';
import type { Node } from '@/types/api';
import { WorkspaceStoreContext } from '../hooks/WorkspaceStoreContext';
import { getOrCreateWorkspaceStore } from './workspaceStoreAdapter';
import { projectNode } from './nodeProjection';
import { queryAll } from '../db/sqlite';
import { ENABLE_SQLITE_STORE } from '../utils/featureFlags';

const NODES_LIMIT = 100;

export interface UseNodesAdapterFilters {
  pages_only?: boolean;
  parent_uuid?: string;
  tag_uuid?: string;
  page_size?: number;
}

/**
 * Adapter hook that lists nodes from the SQLite store when ENABLE_SQLITE_STORE
 * is on, otherwise delegates to the legacy hook.
 */
export function useNodesAdapter(
  filters?: UseNodesAdapterFilters | null
): UseQueryResult<Node[], Error> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const legacyResult = useNodesLegacy(filters ?? undefined);

  const ctx = useContext(WorkspaceStoreContext);
  const [data, setData] = useState<Node[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!ENABLE_SQLITE_STORE || !ctx || !workspaceId) {
      setData([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    getOrCreateWorkspaceStore(workspaceId, ctx.actorId, ctx.cryptoKey, ctx.transport)
      .then((store) => {
        if (cancelled) return;
        const db = store.getDb();

        // Prototype slice: return pages only when pages_only is truthy, otherwise
        // all nodes. Limit to NODES_LIMIT to avoid returning the whole workspace.
        const where = filters?.pages_only ? "WHERE kind = 'page'" : '';
        const rows = queryAll<{ id: string }>(
          db,
          `SELECT id FROM node ${where} ORDER BY created_at DESC LIMIT ?`,
          [NODES_LIMIT]
        );
        const nodes = rows
          .map((row) => projectNode(store, row.id))
          .filter((n): n is Node => n !== undefined);
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
  }, [ctx, workspaceId, filters?.pages_only]);

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
