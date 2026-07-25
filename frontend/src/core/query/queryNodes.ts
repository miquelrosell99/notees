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
import { listClasses, type ClassRow } from './classes';

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
  includeArchived?: boolean;
  /**
   * UUID of the meta "class" system class. When provided, `isClass: true`
   * includes legacy class-page nodes that still carry this class assignment
   * while the data model transitions to kind='class' as the sole discriminator.
   */
  classClassUuid?: string;
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
    classClassUuid: filters.classClassUuid,
  };
}

function projectClassRow(row: ClassRow): Node {
  const now = new Date().toISOString();
  return {
    uuid: row.id,
    name: row.name,
    content: JSON.stringify([{ type: 'text', text: row.name }]),
    icon: row.icon,
    color: row.color,
    parent_uuid: null,
    page_uuid: null,
    sequence: 0,
    active: row.active,
    is_page: false,
    is_class: true,
    create_date: row.createdAt ?? now,
    write_date: row.updatedAt ?? now,
    open_date: null,
    tags_uuid: [],
    classes_uuid: [],
    classes_path_uuid: [],
    properties_uuid: {},
    children: undefined,
    has_children: false,
    backlinks: [],
    linked_references: [],
    backlink_count: 0,
    comment_count: 0,
    aliases_uuid: [],
    aliased_uuid: null,
    extends_uuid: row.extendsClassIds,
    is_private: false,
    parent_locked: false,
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
  const includeArchived = filters.includeArchived ?? false;
  const isActiveMatch = (n: Node): boolean => includeArchived || n.active !== false;

  if (filters.isClass) {
    const classRows = listClasses(store.getDb(), store.getWorkspaceId());
    if (classRows.length > 0) {
      return classRows
        .map(projectClassRow)
        .filter(isActiveMatch)
        .slice(0, LOCAL_QUERY_RESULT_LIMIT);
    }
    // Fall back to the legacy node.kind = 'class' filter while the class table
    // is still being populated during the transition.
  }

  if (filters.ast) {
    const ast = substituteRuntimeParams(filters.ast, filters.runtimeParams ?? {});
    const compiled = compileToSqlite(ast, store.getWorkspaceId());
    const rows = queryAll<{ id: string }>(
      store.getDb(),
      compiled.sql,
      compiled.params as (string | number | null | Uint8Array)[],
    );
    return rows
      .map((row) => projectNode(store, row.id, filters.projectionDepth))
      .filter((n): n is Node => n !== undefined)
      .filter(isActiveMatch)
      .slice(0, LOCAL_QUERY_RESULT_LIMIT);
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
    const rows = queryAll<{ id: string }>(store.getDb(), sql, params);
    return rows
      .map((row) => projectNode(store, row.id, filters.projectionDepth))
      .filter((n): n is Node => n !== undefined)
      .filter(isActiveMatch)
      .slice(0, LOCAL_QUERY_RESULT_LIMIT);
  }

  const results = searchNodes(store, query, searchFilters);
  return results
    .sort((a, b) => b.score - a.score)
    .map((r) => projectNode(store, r.id, filters.projectionDepth))
    .filter((n): n is Node => n !== undefined)
    .filter(isActiveMatch)
    .slice(0, LOCAL_QUERY_RESULT_LIMIT);
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

  if (filters.isClass !== undefined) {
    if (filters.isClass) {
      if (filters.classClassUuid) {
        where.push(
          "(n.kind = 'class' OR (n.kind = 'page' AND EXISTS (SELECT 1 FROM json_each(n.class_ids) WHERE value = ?)))"
        );
        params.push(filters.classClassUuid);
      } else {
        where.push("n.kind = 'class'");
      }
    } else {
      where.push("n.kind != 'class'");
    }
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
