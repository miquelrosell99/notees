/**
 * queryNodes — local-first query execution against the core SQLite derived tables.
 *
 * Replaces the legacy `frontend/src/features/sync/local/localQuery.ts`.
 * Text searches use the derived search_index table; structured filters use the
 * QueryAST → SQLite compiler.
 */

import type { QueryAST } from '@/types';
import type { Node } from '@/types/api';
import type { WorkspaceStore } from '../store';
import { compileToSqlite } from './compileToSqlite';
import { substituteRuntimeParams } from './substituteRuntimeParams';
import { searchNodes, type SearchFilters } from './search';
import { projectNode } from '../adapters/nodeProjection';
import { queryAll } from '../db/sqlite';

const LOCAL_QUERY_RESULT_LIMIT = 500;

export interface QueryNodesFilters {
  ast?: QueryAST;
  runtimeParams?: Record<string, unknown>;
  parentId?: string | null;
  classIds?: string[];
  query?: string;
  isPage?: boolean;
  isClass?: boolean;
  isDaily?: boolean;
}

function buildSearchFilters(filters: QueryNodesFilters): SearchFilters {
  return {
    isPage: filters.isPage,
    isClass: filters.isClass,
    isDaily: filters.isDaily,
    classUuids: filters.classIds,
  };
}

/**
 * Execute a query against the local-first core store.
 *
 * - If `ast` is provided, compiles it to SQLite and projects matching rows to
 *   legacy Node objects.
 * - Otherwise performs a full-text search over the derived search_index table
 *   and applies simple metadata filters.
 */
export function queryNodes(
  store: WorkspaceStore,
  filters: QueryNodesFilters,
): Node[] {
  if (filters.ast) {
    const ast = substituteRuntimeParams(filters.ast, filters.runtimeParams ?? {});
    const compiled = compileToSqlite(ast, store.getWorkspaceId());
    const rows = queryAll<{ id: string }>(
      store.getDb(),
      compiled.sql,
      compiled.params as (string | number | null | Uint8Array)[],
    );
    return rows
      .map((row) => projectNode(store, row.id))
      .filter((n): n is Node => n !== undefined)
      .slice(0, LOCAL_QUERY_RESULT_LIMIT);
  }

  const searchFilters = buildSearchFilters(filters);
  const results = searchNodes(store, filters.query ?? '', searchFilters);
  return results
    .sort((a, b) => b.score - a.score)
    .map((r) => projectNode(store, r.id))
    .filter((n): n is Node => n !== undefined)
    .slice(0, LOCAL_QUERY_RESULT_LIMIT);
}
