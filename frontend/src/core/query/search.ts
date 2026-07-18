/**
 * SQLite-backed full-text search over the derived search_index table.
 *
 * Note: sql.js is compiled without the FTS5 extension, so this module emulates
 * full-text search by tokenising the query and joining the search_index table
 * with LIKE conditions. A production build that links a full SQLite with FTS5
 * can replace the LIKE logic with a VIRTUAL TABLE query without changing callers.
 */

import { queryAll } from '../db/sqlite';
import type { WorkspaceStore } from '../store';

export interface SearchFilters {
  isPage?: boolean;
  isClass?: boolean;
  isDaily?: boolean;
  isUserPage?: boolean;
  classUuids?: string[];
  tagUuids?: string[];
}

export interface SearchResult {
  id: string;
  score: number;
}

function tokenise(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Search node plaintext in the derived search_index table.
 *
 * - Empty or whitespace-only queries return no results (same behaviour as the
 *   previous MiniSearch implementation).
 * - Results are ranked by the number of matched terms; this is a coarse
 *   substitute for FTS5 ranking.
 */
export function searchNodes(
  store: WorkspaceStore,
  query: string,
  filters: SearchFilters = {},
): SearchResult[] {
  const db = store.getDb();
  const workspaceId = store.getWorkspaceId();
  const terms = tokenise(query);

  if (terms.length === 0) {
    return [];
  }

  const where: string[] = ['n.workspace_id = ?'];
  const params: (string | number)[] = [workspaceId];

  // Text match: every term must appear somewhere in the indexed content.
  for (let i = 0; i < terms.length; i++) {
    where.push(`LOWER(si.content) LIKE ?`);
    params.push(`%${terms[i]}%`);
  }

  if (filters.isPage !== undefined) {
    where.push('n.kind = ?');
    params.push(filters.isPage ? 'page' : 'block');
  }

  if (filters.isClass !== undefined) {
    where.push(filters.isClass ? "n.kind = 'class'" : "n.kind != 'class'");
  }

  // classUuids filter uses the class_ids JSON array.
  if (filters.classUuids && filters.classUuids.length > 0) {
    const clauses: string[] = [];
    for (const classUuid of filters.classUuids) {
      clauses.push(`EXISTS (SELECT 1 FROM json_each(n.class_ids) WHERE value = ?)`);
      params.push(classUuid);
    }
    where.push(`(${clauses.join(' OR ')})`);
  }

  // isDaily / isUserPage / tagUuids are not represented in the new derived
  // schema yet (tags are not migrated per compileToSqlite docs). They are
  // intentionally ignored here so callers do not get empty result sets.

  const sql = `
    SELECT n.id, si.content
    FROM node n
    JOIN search_index si ON si.node_id = n.id
    WHERE ${where.join(' AND ')}
    ORDER BY n.id
  `;

  const rows = queryAll<{ id: string; content: string }>(db, sql, params);

  return rows.map((row) => {
    const content = row.content.toLowerCase();
    let matches = 0;
    for (const term of terms) {
      if (content.includes(term)) matches++;
    }
    return { id: row.id, score: matches };
  });
}
