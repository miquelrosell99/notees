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
  kind: 'page' | 'block';
}

/** Maximum number of matching rows to evaluate per kind. */
export const SEARCH_RESULT_LIMIT = 500;

/** How many of the cheap candidate rows get TF-IDF scoring.
 *  Keeping this small avoids the O(rows) cost of matchinfo('pcx') on large workspaces. */
const SCORED_RESULT_LIMIT = 100;
/** How many more FTS matches to fetch than the final limit, so post-join
 *  metadata filters (kind, class) do not starve the result set. */
const CANDIDATE_OVER_FETCH = 4;

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

function buildSearchWhere(filters: SearchFilters, params: (string | number)[]): string[] {
  const where: string[] = ['n.workspace_id = ?', 'si.content MATCH ?'];

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

  return where;
}

interface RawResult {
  id: string;
  kind: 'page' | 'block';
  mi: Uint8Array;
}

interface CandidateResult {
  id: string;
  kind: 'page' | 'block';
}

function runSearchForKind(
  db: ReturnType<WorkspaceStore['getDb']>,
  workspaceId: string,
  matchExpr: string,
  filters: SearchFilters,
  kind: 'page' | 'block',
  totalDocs: number,
  limit: number,
): SearchResult[] {
  // Build the post-join filters (workspace + kind + optional class filters).
  // The MATCH clause is evaluated inside a FTS-first subquery so SQLite cannot
  // choose a plan that scans the node table and probes the virtual table for
  // every row of the workspace.
  const postFilterParams: (string | number)[] = [workspaceId];
  const postFilters: string[] = ['n.workspace_id = ?', 'n.kind = ?'];
  postFilterParams.push(kind === 'page' ? 'page' : 'block');

  if (filters.classUuids && filters.classUuids.length > 0) {
    const clauses: string[] = [];
    for (const classUuid of filters.classUuids) {
      clauses.push(`EXISTS (SELECT 1 FROM json_each(n.class_ids) WHERE value = ?)`);
      postFilterParams.push(classUuid);
    }
    postFilters.push(`(${clauses.join(' OR ')})`);
  }

  // Step 1: cheaply fetch candidate IDs without the expensive matchinfo() call.
  // The inner SELECT hits the FTS index first, then we join to node and apply
  // metadata filters. We over-fetch to compensate for rows dropped by those
  // metadata filters, then apply the final LIMIT.
  const candidateSql = `
    SELECT n.id, n.kind
    FROM (
      SELECT node_id FROM search_index WHERE content MATCH ? LIMIT ?
    ) si
    JOIN node n ON n.id = si.node_id
    WHERE ${postFilters.join(' AND ')}
    LIMIT ?
  `;
  const candidateParams = [
    matchExpr,
    limit * CANDIDATE_OVER_FETCH,
    ...postFilterParams,
    limit,
  ];
  const candidates = queryAll<CandidateResult>(db, candidateSql, candidateParams);

  if (candidates.length === 0) {
    return [];
  }

  // Step 2: score only the first N candidates. matchinfo('pcx') is the expensive
  // part, so limiting the scored set keeps large workspaces responsive. The rest
  // of the candidates keep score 0 and fall back to the cheap candidate order.
  const scoredCandidates = candidates.slice(0, SCORED_RESULT_LIMIT);
  const placeholders = scoredCandidates.map(() => '?').join(',');
  const scoreBaseParams: (string | number)[] = [workspaceId, matchExpr];
  const scoreFilters = buildSearchWhere({ ...filters, isPage: kind === 'page' }, scoreBaseParams);
  const scoreSql = `
    SELECT n.id, n.kind, matchinfo(search_index, 'pcx') AS mi
    FROM search_index si
    JOIN node n ON n.id = si.node_id
    WHERE n.id IN (${placeholders}) AND ${scoreFilters.join(' AND ')}
  `;
  const scoreParams = [...scoredCandidates.map((c) => c.id), ...scoreBaseParams];
  const rows = queryAll<RawResult>(db, scoreSql, scoreParams);

  const scores = new Map<string, number>();
  for (const row of rows) {
    scores.set(row.id, scoreFromMatchinfo(row.mi, totalDocs));
  }

  const candidateOrder = new Map(candidates.map((c, i) => [c.id, i]));
  const results = candidates.map((c) => ({
    id: c.id,
    score: scores.get(c.id) ?? 0,
    kind: c.kind,
  }));
  results.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (scoreDiff !== 0) return scoreDiff;
    // Preserve the cheap candidate order as a stable tie-breaker.
    return (candidateOrder.get(a.id) ?? 0) - (candidateOrder.get(b.id) ?? 0);
  });
  return results;
}

/**
 * Search node plaintext using the FTS4 search_index virtual table.
 *
 * - Empty or whitespace-only queries return no results.
 * - Terms are prefix-matched by default ("proj" matches "project").
 * - Results are ranked by a TF-IDF score derived from matchinfo() over a small
 *   window of cheaply-selected candidates.
 * - Pages are returned before blocks, each group sorted by relevance.
 * - The raw SQL is capped per kind so typing short prefixes cannot force the
 *   worker to score an unbounded number of FTS matches.
 */
export function searchNodes(
  store: WorkspaceStore,
  query: string,
  filters: SearchFilters = {},
  limit = SEARCH_RESULT_LIMIT,
): SearchResult[] {
  const db = store.getDb();
  const workspaceId = store.getWorkspaceId();
  const matchExpr = toFtsMatchExpression(query);
  if (!matchExpr) {
    return [];
  }

  const totalDocsRow = db.exec('SELECT COUNT(*) FROM search_index')[0];
  const totalDocs = (totalDocsRow?.values[0]?.[0] as number | undefined) ?? 0;

  if (filters.isPage !== undefined) {
    const kind = filters.isPage ? 'page' : 'block';
    return runSearchForKind(db, workspaceId, matchExpr, filters, kind, totalDocs, limit);
  }

  const pages = runSearchForKind(db, workspaceId, matchExpr, filters, 'page', totalDocs, limit);
  const blocks = runSearchForKind(db, workspaceId, matchExpr, filters, 'block', totalDocs, limit);
  return [...pages, ...blocks];
}
