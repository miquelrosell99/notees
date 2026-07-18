import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import type { QueryAST } from '@/types';
import type { Node } from '@/types/api';
import { substituteRuntimeParams } from '../query/substituteRuntimeParams';
import { compileToSqlite } from '../query/compileToSqlite';
import { queryAll } from '../db/sqlite';
import { projectNode } from '../adapters/nodeProjection';
import { useWorkspaceStore } from './useWorkspaceStore';

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
  const { store, isLoading: storeLoading, error: storeError } = useWorkspaceStore(workspaceId ?? '');
  const [data, setData] = useState<Node[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!store || !workspaceId) {
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

    try {
      const astWithParams = substituteRuntimeParams(ast, runtimeParams ?? {});
      const compiled = compileToSqlite(astWithParams, workspaceId);
      const rows = queryAll<{ id: string }>(
        store.getDb(),
        compiled.sql,
        compiled.params as (string | number | null | Uint8Array)[]
      );
      const nodes = rows
        .map((row) => projectNode(store, row.id))
        .filter((n): n is Node => n !== undefined);
      setData(nodes);
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
