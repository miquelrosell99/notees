/**
 * executeQuery — imperative local-first query execution against the core SQLite
 * derived store.
 *
 * Replaces the legacy `executeQuery` call previously provided by the NodeViews API.
 */

import type { QueryAST, QueryExecuteRequest, QueryExecuteResponse, QueryGroupResult } from '@/types/nodeView';
import type { WorkspaceStore } from '../store';
import { compileToSqlite } from './compileToSqlite';
import { substituteRuntimeParams } from './substituteRuntimeParams';
import { queryNodes } from './queryNodes';
import { queryAll } from '../db/sqlite';

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

function executeAggregate(
  store: WorkspaceStore,
  ast: QueryAST,
  currentNodeUuid?: string
): QueryExecuteResponse {
  const workspaceId = store.getWorkspaceId();
  const compiled = compileToSqlite(ast, workspaceId, currentNodeUuid);
  const rows = queryAll<Record<string, unknown>>(
    store.getDb(),
    compiled.sql,
    compiled.params as (string | number | null | Uint8Array)[]
  );
  const groups = mapAggregateRows(rows);
  return {
    nodes: [],
    groups,
    total_count: groups.length,
    metrics: undefined,
  };
}

/**
 * Execute a QueryExecuteRequest against the local-first core store.
 *
 * - If `request.aggregation` is present, returns aggregation groups.
 * - Otherwise returns projected Node objects, honouring `limit`/`offset`.
 */
export function executeQuery(
  store: WorkspaceStore,
  request: QueryExecuteRequest,
  currentNodeUuid?: string
): QueryExecuteResponse {
  if (!request.query_ast) {
    return { nodes: [], groups: undefined, total_count: 0, metrics: undefined };
  }

  const ast = substituteRuntimeParams(request.query_ast, request.runtime_params ?? {});

  if (request.aggregation) {
    const astWithAggregation: QueryAST = {
      ...ast,
      aggregation: request.aggregation,
    };
    return executeAggregate(store, astWithAggregation, currentNodeUuid);
  }

  const nodes = queryNodes(store, {
    ast,
    runtimeParams: request.runtime_params,
  });

  const offset = request.offset ?? 0;
  const limit = request.limit;
  const sliced =
    limit !== undefined
      ? nodes.slice(offset, offset + limit)
      : nodes.slice(offset);

  return {
    nodes: sliced,
    groups: undefined,
    total_count: nodes.length,
    metrics: undefined,
  };
}
