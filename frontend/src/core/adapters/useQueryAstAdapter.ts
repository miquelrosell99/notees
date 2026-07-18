import type { UseQueryResult } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import type { QueryExecuteRequest } from '@/types/nodeView';
import type { QueryAST } from '@/types';
import {
  useQuery_Legacy,
  useNodeViewQueryLegacy,
} from '@/features/content/hooks/useNodeViews.queries';
import { useQueryAst } from '../hooks/useQueryAst';
import { ENABLE_SQLITE_STORE } from '../utils/featureFlags';

/**
 * Adapter for executing an ad-hoc QueryAST. Delegates to the legacy hook when
 * ENABLE_SQLITE_STORE is off; otherwise evaluates the AST against the SQLite store.
 */
export function useExecuteQueryAdapter(
  request: QueryExecuteRequest,
  options?: {
    enabled?: boolean;
    queryKey?: readonly unknown[];
  }
): UseQueryResult<Node[], Error> {
  const legacyResult = useQuery_Legacy(request, options);
  const ast = request.query_ast;
  const sqliteResult = useQueryAst(ast ?? null, request.runtime_params);

  if (!ENABLE_SQLITE_STORE) {
    return legacyResult as UseQueryResult<Node[], Error>;
  }
  return sqliteResult;
}

/**
 * Adapter for executing a NodeView query. Delegates to the legacy hook when
 * ENABLE_SQLITE_STORE is off; otherwise evaluates the AST against the SQLite store.
 */
export function useQueryResultsAdapter(
  viewId: string | number,
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
  const legacyResult = useNodeViewQueryLegacy(viewId, options);
  const ast = options?.ast;
  const sqliteResult = useQueryAst(ast ?? null, options?.runtimeParams);

  if (!ENABLE_SQLITE_STORE) {
    return legacyResult as UseQueryResult<Node[], Error>;
  }
  return sqliteResult;
}
