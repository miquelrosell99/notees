import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import type { QueryAST } from '@/types';
import type { Node } from '@/types/api';
import type { QueryExecuteResponse } from '@/types/nodeView';
import { substituteRuntimeParams } from '../query/substituteRuntimeParams';
import { useWorkspaceStoreClient } from './useWorkspaceStoreClient';

function createEmptyResult(): UseQueryResult<QueryExecuteResponse, Error> {
  return {
    data: { nodes: [], groups: undefined, total_count: 0, metrics: undefined },
    isLoading: false,
    isError: false,
    error: null,
    isPending: false,
    isSuccess: true,
    status: 'success',
    fetchStatus: 'idle',
  } as unknown as UseQueryResult<QueryExecuteResponse, Error>;
}

/**
 * Execute a QueryAST against the SQLite derived tables and return either
 * projected Node objects or aggregation groups when `ast.aggregation` is set.
 */
export function useQueryAstAggregate(
  ast: QueryAST | null,
  runtimeParams?: Record<string, unknown>
): UseQueryResult<QueryExecuteResponse, Error> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { client, isLoading: storeLoading, error: storeError } = useWorkspaceStoreClient(workspaceId ?? '');
  const [data, setData] = useState<QueryExecuteResponse>({
    nodes: [],
    groups: undefined,
    total_count: 0,
    metrics: undefined,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!client || !workspaceId) {
      setData({ nodes: [], groups: undefined, total_count: 0, metrics: undefined });
      setIsLoading(false);
      setError(null);
      return;
    }

    if (!ast) {
      setData({ nodes: [], groups: undefined, total_count: 0, metrics: undefined });
      setIsLoading(false);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    const run = async (): Promise<void> => {
      try {
        const astWithParams = substituteRuntimeParams(ast, runtimeParams ?? {});
        if (astWithParams.aggregation) {
          const response = await client.query<QueryExecuteResponse>('executeQuery', [
            { query_ast: astWithParams, runtime_params: {}, aggregation: astWithParams.aggregation },
            undefined,
          ]);
          setData(response);
        } else {
          const nodes = await client.query<Node[]>('queryNodes', [
            { ast, runtimeParams, projectionDepth: 0 },
          ]);
          setData({ nodes, groups: undefined, total_count: nodes.length, metrics: undefined });
        }
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setIsLoading(false);
      }
    };

    run();
  }, [client, workspaceId, ast, runtimeParams]);

  if (!ast) {
    return createEmptyResult();
  }

  const isPending = storeLoading || isLoading;
  const resolvedError = error ?? storeError;
  const isErrorState = resolvedError !== null;
  const status: UseQueryResult<QueryExecuteResponse, Error>['status'] = isPending
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
  } as unknown as UseQueryResult<QueryExecuteResponse, Error>;
}
