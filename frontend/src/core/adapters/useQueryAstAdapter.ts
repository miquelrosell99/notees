import type { UseQueryResult } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import type { QueryExecuteRequest } from '@/types/nodeView';
import type { QueryAST } from '@/types';
import { useQueryAst } from '../hooks/useQueryAst';

/**
 * Adapter for executing an ad-hoc QueryAST against the local-first SQLite store.
 */
export function useExecuteQueryAdapter(
  request: QueryExecuteRequest,
  _options?: {
    enabled?: boolean;
    queryKey?: readonly unknown[];
  }
): UseQueryResult<Node[], Error> {
  const ast = request.query_ast;
  return useQueryAst(ast ?? null, request.runtime_params);
}

/**
 * Adapter for executing a NodeView query against the local-first SQLite store.
 */
export function useQueryResultsAdapter(
  _viewId: string | number,
  options?: {
    runtimeParams?: Record<string, unknown>;
    limit?: number;
    offset?: number;
    orderBy?: string;
    includeChildren?: boolean;
    includeAllChildren?: boolean;
    pagesOnly?: boolean;
    includeProperties?: boolean;
    enrich?: { children?: boolean; classes?: boolean; properties?: boolean };
    enabled?: boolean;
    ast?: QueryAST;
  }
): UseQueryResult<Node[], Error> {
  const ast = options?.ast;
  return useQueryAst(ast ?? null, options?.runtimeParams);
}
