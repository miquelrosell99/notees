import { useContext, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Database } from 'sql.js';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import { WorkspaceStoreContext } from '../hooks/WorkspaceStoreContext';
import { getOrCreateWorkspaceStoreClient } from './workspaceStoreClientAdapter';
import { projectNodeFromDb } from './nodeProjection';
import { queryAll } from '../db/sqlite';

const NODES_LIMIT = 100;

export interface UseNodesAdapterFilters {
  pages_only?: boolean;
  parent_uuid?: string;
  tag_uuid?: string;
  page_size?: number;
}

/**
 * Adapter hook that lists nodes through the async worker-backed store client.
 *
 * TODO: This fetches the underlying sql.js Database via `client.query('getDb')`,
 * which works in the jsdom test shim but cannot work in a real Web Worker.
 * Replace with a worker-side query method (e.g. `client.query('listNodes', filters)`)
 * before enabling the Web Worker path in production.
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

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    getOrCreateWorkspaceStoreClient(workspaceId, ctx.actorId, ctx.transport)
      .then(async (client) => {
        if (cancelled) return;

        const [db] = await Promise.all([
          client.query<Database>('getDb', []),
          client.query<string>('getWorkspaceId', []),
        ]);
        if (cancelled) return;

        const where = filters?.pages_only ? "WHERE kind = 'page'" : '';
        const rows = queryAll<{ id: string }>(
          db,
          `SELECT id FROM node ${where} ORDER BY created_at DESC LIMIT ?`,
          [filters?.page_size ?? NODES_LIMIT]
        );
        const nodes = rows
          .map((row) => projectNodeFromDb(db, workspaceId, row.id))
          .filter((n): n is Node => n !== undefined);
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
  }, [ctx, workspaceId, filters?.pages_only, filters?.page_size]);

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
