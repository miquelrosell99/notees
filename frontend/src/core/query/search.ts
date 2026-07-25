/**
 * SQLite-backed full-text search over the derived search_index table.
 *
 * sql.js ships with the FTS4 extension, so we use a real FTS4 virtual table
 * (see frontend/src/core/db/schema.ts). This gives tokenisation, prefix
 * matching, and ranked results without recompiling the WASM build. If we ever
 * switch to a custom SQLite build with FTS5, only the ranking formula below
 * needs to change; callers stay the same.
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

function buildMatchExpression(terms: string[]): string {
  // Build an FTS4 MATCH expression with implicit AND and prefix wildcards.
  // We strip characters that the unicode61 tokenizer treats as token
  // separators (quotes, parentheses, etc.) so user input cannot accidentally
  // trigger FTS4 query syntax such as OR / NEAR / NOT.
  return terms
    .map((term) => term.replace(/[^\p{L}\p{N}_']/gu, ''))
    .filter((term) => term.length > 0)
    .map((term) => `${term}*`)
    .join(' ');
}

/**
 * Convert a user-typed search string into an FTS4 MATCH expression.
 * Returns null if the query contains no searchable tokens.
 */
export function toFtsMatchExpression(query: string): string | null {
  const terms = tokenise(query);
  const expr = buildMatchExpression(terms);
  return expr.length > 0 ? expr : null;
}

/**
 * Compute a TF-IDF-style score from an FTS4 matchinfo('pcx') blob.
 *
 * The blob layout is:
 *   [p, c, x0, x1, ..., x(p*c*3 - 1)]
 * where:
 *   p = number of phrases in the query
 *   c = number of columns in the FTS table
 *   x[i*3 + 0] = hits in this row/column for phrase i
 *   x[i*3 + 1] = hits across all rows/columns for phrase i
 *   x[i*3 + 2] = rows with hits for phrase i
 *
 * Values are 32-bit unsigned integers in little-endian byte order.
 */
function scoreFromMatchinfo(mi: Uint8Array, totalDocs: number): number {
  const view = new DataView(mi.buffer, mi.byteOffset, mi.byteLength);
  const ints: number[] = [];
  for (let i = 0; i < mi.byteLength / 4; i++) {
    ints.push(view.getUint32(i * 4, true));
  }

  const phraseCount = ints[0];
  const columnCount = ints[1];
  let score = 0;

  for (let phrase = 0; phrase < phraseCount; phrase++) {
    for (let col = 0; col < columnCount; col++) {
      const idx = 2 + (phrase * columnCount + col) * 3;
      const thisDocHits = ints[idx];
      const docsWithHits = ints[idx + 2];
      if (thisDocHits === 0) continue;
      const idf = Math.log((totalDocs + 1) / (docsWithHits + 1)) + 1;
      score += thisDocHits * idf;
    }
  }

  return score;
}

/**
 * Search node plaintext using the FTS4 search_index virtual table.
 *
 * - Empty or whitespace-only queries return no results.
 * - Terms are prefix-matched by default ("proj" matches "project").
 * - Results are ranked by a TF-IDF score derived from matchinfo().
 */
export function searchNodes(
  store: WorkspaceStore,
  query: string,
  filters: SearchFilters = {},
): SearchResult[] {
  const db = store.getDb();
  const workspaceId = store.getWorkspaceId();
  const matchExpr = toFtsMatchExpression(query);
  if (!matchExpr) {
    return [];
  }
  const where: string[] = ['n.workspace_id = ?', 'si.content MATCH ?'];
  const params: (string | number)[] = [workspaceId, matchExpr];

  if (filters.isPage !== undefined) {
    where.push('n.kind = ?');
    params.push(filters.isPage ? 'page' : 'block');
  }

  if (filters.isClass !== undefined) {
    // Classes are stored in the dedicated `class` table, not in `node.kind`.
    // isClass:true is handled by callers via listClasses; here we simply
    // exclude the impossible case.
    if (!filters.isClass) {
      where.push("n.kind != 'class'");
    }
  }

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

  const totalDocsRow = db.exec('SELECT COUNT(*) FROM search_index')[0];
  const totalDocs = (totalDocsRow?.values[0]?.[0] as number | undefined) ?? 0;

  const sql = `
    SELECT n.id, matchinfo(search_index, 'pcx') AS mi
    FROM search_index si
    JOIN node n ON n.id = si.node_id
    WHERE ${where.join(' AND ')}
  `;

  const rows = queryAll<{ id: string; mi: Uint8Array }>(db, sql, params);

  const results: SearchResult[] = rows.map((row) => ({
    id: row.id,
    score: scoreFromMatchinfo(row.mi, totalDocs),
  }));

  results.sort((a, b) => b.score - a.score);
  return results;
}
