import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import type { QueryAST } from '@/types';
import type { QueryExecuteResponse, QueryGroupResult } from '@/types/nodeView';
import { substituteRuntimeParams } from '../query/substituteRuntimeParams';
import { compileToSqlite } from '../query/compileToSqlite';
import { queryAll } from '../db/sqlite';
import { queryNodes } from '../query/queryNodes';
import { useWorkspaceStore } from './useWorkspaceStore';

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

function mapAggregateRows(rows: Record<string, unknown>[]): QueryGroupResult[] {
  return rows.map((row) => {
    const result: QueryGroupResult = {
      value: Number(row.value ?? 0),
    };
    for (const key of Object.keys(row)) {
      if (key === 'value') continue;
      result[key] = row[key] as string | number | null | undefined;
    }
    return result;
  });
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
  const { store, isLoading: storeLoading, error: storeError } = useWorkspaceStore(workspaceId ?? '');
  const [data, setData] = useState<QueryExecuteResponse>({
    nodes: [],
    groups: undefined,
    total_count: 0,
    metrics: undefined,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!store || !workspaceId) {
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

    try {
      const astWithParams = substituteRuntimeParams(ast, runtimeParams ?? {});
      if (astWithParams.aggregation) {
        const compiled = compileToSqlite(astWithParams, workspaceId);
        const rows = queryAll<Record<string, unknown>>(
          store.getDb(),
          compiled.sql,
          compiled.params as (string | number | null | Uint8Array)[]
        );
        const groups = mapAggregateRows(rows);
        setData({ nodes: [], groups, total_count: groups.length, metrics: undefined });
      } else {
        const nodes = queryNodes(store, { ast: astWithParams, runtimeParams });
        setData({ nodes, groups: undefined, total_count: nodes.length, metrics: undefined });
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [store, workspaceId, ast, runtimeParams]);

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
