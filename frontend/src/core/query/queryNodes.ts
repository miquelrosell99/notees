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
import { searchNodes, SEARCH_RESULT_LIMIT, type SearchFilters } from './search';
import { projectNodes } from '../adapters/nodeProjection';
import { queryAll } from '../db/sqlite';
import { listClasses, classRowToNode } from './classes';

const SLOW_QUERY_MS = 500;

interface QueryTiming {
  sqlMs: number;
  projectionMs: number;
  totalMs: number;
  rowCount: number;
  resultCount: number;
  depth: number;
}

function logQueryTiming(method: string, timing: QueryTiming): void {
  if (timing.totalMs <= SLOW_QUERY_MS) return;
  console.warn(
    `[queryNodes] Slow query ${method} took ${timing.totalMs.toFixed(1)}ms ` +
      `(sql=${timing.sqlMs.toFixed(1)}ms projection=${timing.projectionMs.toFixed(1)}ms ` +
      `rows=${timing.rowCount} results=${timing.resultCount} depth=${timing.depth})`
  );
}

function projectUntilLimit(
  store: WorkspaceStore,
  ids: string[],
  depth: number | undefined,
  limit: number,
  isActiveMatch: (n: Node) => boolean
): Node[] {
  const result: Node[] = [];
  // Project slightly more than the limit in each chunk so a few archived rows
  // do not force an extra projection round.
  const chunkSize = limit + 100;
  for (let i = 0; i < ids.length && result.length < limit; i += chunkSize) {
    const chunkIds = ids.slice(i, i + chunkSize);
    const projected = projectNodes(store, chunkIds, depth).filter(isActiveMatch);
    result.push(...projected);
  }
  return result.slice(0, limit);
}

export interface QueryNodesFilters {
  ast?: QueryAST;
  runtimeParams?: Record<string, unknown>;
  parentId?: string | null;
  classIds?: string[];
  query?: string;
  isPage?: boolean;
  isClass?: boolean;
  isDaily?: boolean;
  includeArchived?: boolean;
  /**
   * How many levels of children to project for each result. List/collection
   * views should pass 0 to avoid the huge cost of recursively fetching children
   * that they never render.
   */
  projectionDepth?: number;
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
  const start = performance.now();
  const includeArchived = filters.includeArchived ?? false;
  const isActiveMatch = (n: Node): boolean => includeArchived || n.active !== false;

  if (filters.isClass) {
    const classRows = listClasses(store.getDb(), store.getWorkspaceId());
    return classRows
      .map(classRowToNode)
      .filter(isActiveMatch)
      .slice(0, SEARCH_RESULT_LIMIT);
  }

  if (filters.ast) {
    const ast = substituteRuntimeParams(filters.ast, filters.runtimeParams ?? {});
    const compiled = compileToSqlite(ast, store.getWorkspaceId());
    const sqlStart = performance.now();
    const rows = queryAll<{ id: string }>(
      store.getDb(),
      compiled.sql,
      compiled.params as (string | number | null | Uint8Array)[],
    );
    const sqlMs = performance.now() - sqlStart;
    const ids = rows.map((row) => row.id);
    const projStart = performance.now();
    const result = projectUntilLimit(store, ids, filters.projectionDepth, SEARCH_RESULT_LIMIT, isActiveMatch);
    const projectionMs = performance.now() - projStart;
    logQueryTiming('ast', {
      sqlMs,
      projectionMs,
      totalMs: performance.now() - start,
      rowCount: rows.length,
      resultCount: result.length,
      depth: filters.projectionDepth ?? 2,
    });
    return result;
  }

  const searchFilters = buildSearchFilters(filters);
  const query = filters.query ?? '';

  // If there is no text query but metadata filters are present, list matching
  // nodes directly instead of returning an empty search result.
  const hasMetadataFilters =
    filters.isPage !== undefined ||
    filters.isClass !== undefined ||
    filters.isDaily !== undefined ||
    (filters.classIds !== undefined && filters.classIds.length > 0);

  if (query.trim() === '' && hasMetadataFilters) {
    const { sql, params } = listNodesSql(store.getWorkspaceId(), filters);
    const sqlStart = performance.now();
    const rows = queryAll<{ id: string }>(store.getDb(), sql, params);
    const ids = rows.map((row) => row.id);
    const sqlMs = performance.now() - sqlStart;
    const projStart = performance.now();
    const result = projectUntilLimit(store, ids, filters.projectionDepth, SEARCH_RESULT_LIMIT, isActiveMatch);
    const projectionMs = performance.now() - projStart;
    logQueryTiming('metadata', {
      sqlMs,
      projectionMs,
      totalMs: performance.now() - start,
      rowCount: rows.length,
      resultCount: result.length,
      depth: filters.projectionDepth ?? 2,
    });
    return result;
  }

  const sqlStart = performance.now();
  const results = searchNodes(store, query, searchFilters, SEARCH_RESULT_LIMIT);
  const sqlMs = performance.now() - sqlStart;
  const sortedIds = results.sort((a, b) => b.score - a.score).map((r) => r.id);
  const projStart = performance.now();
  const result = projectUntilLimit(store, sortedIds, filters.projectionDepth, SEARCH_RESULT_LIMIT, isActiveMatch);
  const projectionMs = performance.now() - projStart;
  logQueryTiming('search', {
    sqlMs,
    projectionMs,
    totalMs: performance.now() - start,
    rowCount: results.length,
    resultCount: result.length,
    depth: filters.projectionDepth ?? 2,
  });
  return result;
}

function listNodesSql(workspaceId: string, filters: QueryNodesFilters): { sql: string; params: (string | number)[] } {
  const where: string[] = ['n.workspace_id = ?'];
  const params: (string | number)[] = [workspaceId];

  if (!filters.includeArchived) {
    where.push('n.active = 1');
  }

  if (filters.isPage !== undefined) {
    where.push('n.kind = ?');
    params.push(filters.isPage ? 'page' : 'block');
  }

  if (filters.classIds !== undefined && filters.classIds.length > 0) {
    const clauses: string[] = [];
    for (const classUuid of filters.classIds) {
      clauses.push('EXISTS (SELECT 1 FROM json_each(n.class_ids) WHERE value = ?)');
      params.push(classUuid);
    }
    where.push(`(${clauses.join(' OR ')})`);
  }

  const sql = `SELECT n.id FROM node n WHERE ${where.join(' AND ')} ORDER BY n.id`;
  return { sql, params };
}
