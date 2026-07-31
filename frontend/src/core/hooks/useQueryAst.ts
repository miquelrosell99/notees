import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import type { QueryAST } from '@/types';
import type { Node } from '@/types/api';
import { useWorkspaceStoreClient } from './useWorkspaceStoreClient';

function createEmptyResult(): UseQueryResult<Node[], Error> {
  return {
    data: [],
    isLoading: false,
    isError: false,
    error: null,
    isPending: false,
    isSuccess: true,
    status: 'success',
    fetchStatus: 'idle',
  } as unknown as UseQueryResult<Node[], Error>;
}

/**
 * Execute a QueryAST against the SQLite derived tables and return projected Node
 * objects.
 */
export function useQueryAst(
  ast: QueryAST | null,
  runtimeParams?: Record<string, unknown>
): UseQueryResult<Node[], Error> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { client, isLoading: storeLoading, error: storeError } = useWorkspaceStoreClient(workspaceId ?? '');
  const [data, setData] = useState<Node[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Stabilise object-shaped deps so callers that create a new AST/params object
  // on every render do not restart the query every render and trigger a loop.
  const astKey = useMemo(() => (ast ? JSON.stringify(ast) : ''), [ast]);
  const paramsKey = useMemo(() => JSON.stringify(runtimeParams ?? {}), [runtimeParams]);

  useEffect(() => {
    if (!client || !workspaceId) {
      setData([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    if (!ast) {
      setData([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    const run = async (): Promise<void> => {
      try {
        const nodes = await client.query<Node[]>('queryNodes', [
          { ast, runtimeParams, projectionDepth: 0 },
        ]);
        setData(nodes);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setIsLoading(false);
      }
    };

    run();
    // ast/runtimeParams are intentionally replaced by their stable string keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, workspaceId, astKey, paramsKey]);

  if (!ast) {
    return createEmptyResult();
  }

  const isPending = storeLoading || isLoading;
  const resolvedError = error ?? storeError;
  const isErrorState = resolvedError !== null;
  const status: UseQueryResult<Node[], Error>['status'] = isPending
    ? 'pending'
    : isErrorState
      ? 'error'
      : 'success';

  return {
    data,
    isLoading: isPending,
    isError: isErrorState,
    error: resolvedError,
    isPending,
    isSuccess: !isPending && !isErrorState,
    status,
    fetchStatus: 'idle',
  } as unknown as UseQueryResult<Node[], Error>;
}
