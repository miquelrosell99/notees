/**
 * FTS5 maintenance (v1 `derived/search.py` port, FTS4 -> FTS5). Rows are
 * addressed by rowid through the search_index_docid map, so reindex and
 * delete are O(log n) instead of a full docstore scan per statement.
 */

import type { StoreDatabase } from "./types.js";
import { extractSearchPlaintext } from "./content.js";

export function removeSearchIndexEntry(db: StoreDatabase, nodeId: string): void {
  db.prepare(
    "DELETE FROM search_index WHERE rowid = (SELECT docid FROM search_index_docid WHERE node_id = ?)",
  ).run(nodeId);
  db.prepare("DELETE FROM search_index_docid WHERE node_id = ?").run(nodeId);
}

export function reindexNode(db: StoreDatabase, nodeId: string): void {
  const row = db.prepare("SELECT content FROM node WHERE id = ?").get(nodeId) as
    | { content: string }
    | undefined;
  if (!row) return;
  // Title-is-content: the indexed text is the content plaintext — a page's
  // title lives in its content, so title search rides the same index; the
  // node's text-ish property values fold in too (§34.30 M5).
  const indexed = extractSearchPlaintext(db, row.content, nodeId);
  if (!indexed) {
    removeSearchIndexEntry(db, nodeId);
    return;
  }
  db.prepare(
    "DELETE FROM search_index WHERE rowid = (SELECT docid FROM search_index_docid WHERE node_id = ?)",
  ).run(nodeId);
  db.prepare("INSERT INTO search_index (content) VALUES (?)").run(indexed);
  // last_insert_rowid() is the docid of the row just inserted on this
  // connection; keep the map in sync for the next reindex/delete.
  db.prepare(
    "INSERT OR REPLACE INTO search_index_docid (node_id, docid) VALUES (?, last_insert_rowid())",
  ).run(nodeId);
}

/**
 * The maximal letter/digit runs of a query — the prefix terms the MATCH
 * query ANDs. Exposed for the snippet helper (M3), which needs the same
 * term splitting without the FTS syntax.
 */
export function matchTerms(query: string): string[] {
  return query
    .trim()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/**
 * Prefix-AND FTS query (v1 client search pattern) with quoted-phrase support
 * (§34.30 C1): each maximal run of letters/digits OUTSIDE double quotes
 * becomes a bare prefix token; each double-quoted segment becomes an exact
 * FTS phrase (valid MATCH syntax on FTS4 and FTS5 alike — verified against
 * the shipped sql.js wasm; FTS5's `"term"*` phrase-PREFIX stays off the table
 * because FTS4 silently no-matches it). An unterminated quote degrades to
 * plain text. Splitting at every non-alphanumeric boundary mirrors the
 * unicode61 tokenizer (which splits indexed text at the same boundaries), so
 * "11607-1" compiles to `11607* AND 1*` and matches the indexed tokens
 * instead of merging into a nonexistent "116071". Bare tokens must not carry
 * FTS query syntax (quotes, parens, colons), which is why the quoted segments
 * are extracted before the prefix pass runs.
 */
export function buildMatchQuery(query: string): string | null {
  const clauses: string[] = [];
  const unquoted: string[] = [];
  const pattern = /"([^"]*)"/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(query)) !== null) {
    unquoted.push(query.slice(last, match.index));
    last = match.index + match[0].length;
    const terms = matchTerms(match[1]!);
    if (terms.length > 0) clauses.push(`"${terms.join(" ")}"`);
  }
  unquoted.push(query.slice(last));
  for (const term of matchTerms(unquoted.join(" "))) clauses.push(`${term}*`);
  if (clauses.length === 0) return null;
  return clauses.join(" AND ");
}

/**
 * Parse the opaque pagination cursor into a row offset. The cursor is the
 * decimal offset string the previous page returned (null = first page);
 * anything else fails loud — a silently-reset cursor would make the UI
 * jump back to the first page mid-browse.
 */
function parseSearchCursor(cursor: string | null | undefined): number {
  if (cursor === null || cursor === undefined || cursor === "") return 0;
  if (!/^\d+$/.test(cursor)) throw new Error(`search: invalid cursor "${cursor}"`);
  return Number(cursor);
}

// --- ranked search (§34.30 M2) ---------------------------------------------------
//
// FTS5 orders by the hidden `rank` column (bm25 — ascending, most negative
// first) directly in SQL. The stock sql.js build's FTS4 has NO rank column
// (verified against the shipped wasm: "no such column: rank"), so that
// module fetches matchinfo('x') hit counts and scores in JS. Both paths
// tiebreak by recency (node.updated_at DESC — SQLite puts NULLs last in
// DESC) then node id, so ordering is deterministic and near-identical
// across modules. The module is a property of the DATABASE, not the
// backend: a cross-backend snapshot restore can park an FTS4 index inside
// better-sqlite3 (still queryable, so the repair path keeps it), which is
// why it is detected from sqlite_master and cached per connection (restore
// swaps the connection, invalidating the cache). The title-weight variant
// (a first-block column) is a DDL change sequenced after this slice.

export interface RankedSearchHit {
  nodeId: string;
}

export interface RankedSearchPage {
  hits: RankedSearchHit[];
  /**
   * Offset cursor for the next page (opaque to callers), or null when this
   * page exhausted the match set. Ranking is deterministic (relevance,
   * recency, id), so an offset cursor pages a stable order; a concurrent edit
   * may shift rows at worst, never corrupt.
   */
  nextCursor: string | null;
}

/** Detected search_index module, cached per connection (a WeakMap: restore
 *  re-opens the database, so a new connection starts with a fresh entry). */
const indexModuleCache = new WeakMap<object, "fts5" | "fts4">();

export function searchIndexModule(db: StoreDatabase): "fts5" | "fts4" {
  const cached = indexModuleCache.get(db);
  if (cached) return cached;
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'search_index'")
    .get() as { sql: string | null } | undefined;
  const module = row?.sql?.toLowerCase().includes("using fts5") ? "fts5" : "fts4";
  indexModuleCache.set(db, module);
  return module;
}

interface Fts4MatchRow {
  nodeId: string;
  updatedAt: string | null;
  mi: unknown;
}

/** Sum of per-phrase hit counts in this row from a matchinfo('x') blob. */
function matchinfoHitScore(mi: unknown, phraseCount: number): number {
  if (!(mi instanceof Uint8Array)) return 0;
  const view = new DataView(mi.buffer, mi.byteOffset, mi.length);
  let score = 0;
  // 'x' layout: per phrase, per column (one column in search_index),
  // 3 big-endian uint32: hits-this-row, hits-all-rows, rows-with-hits.
  for (let phrase = 0; phrase < phraseCount; phrase++) {
    const offset = phrase * 3 * 4;
    if (offset + 4 <= view.byteLength) score += view.getUint32(offset, false);
  }
  return score;
}

/** Recency comparison: newer first; NULL timestamps (never updated) last. */
function compareRecency(a: string | null, b: string | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return a < b ? 1 : a > b ? -1 : 0;
}

/**
 * Ranked FTS search over active nodes: relevance first (rank / hit count),
 * recency tiebreak, node id for full determinism.
 */
export function searchNodes(db: StoreDatabase, query: string, limit: number): RankedSearchHit[] {
  return searchNodesPage(db, query, limit).hits;
}

/**
 * Cursor-paginated ranked search (§34.30 C5): the same deterministic order
 * as searchNodes, sliced one page at a time. The returned cursor is the
 * opaque next-page argument (null = done).
 */
export function searchNodesPage(
  db: StoreDatabase,
  query: string,
  limit: number,
  cursor: string | null = null,
): RankedSearchPage {
  const match = buildMatchQuery(query);
  if (match === null) return { hits: [], nextCursor: null };
  const offset = parseSearchCursor(cursor);
  if (searchIndexModule(db) === "fts5") {
    const hits = db
      .prepare(
        `SELECT d.node_id AS nodeId FROM search_index s
         JOIN search_index_docid d ON d.docid = s.rowid
         JOIN node n ON n.id = d.node_id AND n.is_active = 1
         WHERE search_index MATCH ?
         ORDER BY s.rank ASC, n.updated_at DESC, d.node_id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(match, limit, offset) as RankedSearchHit[];
    return { hits, nextCursor: hits.length === limit ? String(offset + limit) : null };
  }
  const rows = db
    .prepare(
      `SELECT d.node_id AS nodeId, n.updated_at AS updatedAt,
              matchinfo(search_index, 'x') AS mi
       FROM search_index s
       JOIN search_index_docid d ON d.docid = s.rowid
       JOIN node n ON n.id = d.node_id AND n.is_active = 1
       WHERE search_index MATCH ?`,
    )
    .all(match) as unknown as Fts4MatchRow[];
  // Every AND clause (prefix token or quoted phrase) is exactly one FTS
  // phrase — 'x' layout is per phrase — so the clause count, not the raw
  // term count, sizes the matchinfo blob (C1 phrases make them differ).
  const phraseCount = match.split(" AND ").length;
  const hits = rows
    .map((row) => ({ ...row, score: matchinfoHitScore(row.mi, phraseCount) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        compareRecency(a.updatedAt, b.updatedAt) ||
        (a.nodeId < b.nodeId ? -1 : 1),
    )
    .slice(offset, offset + limit)
    .map(({ nodeId }) => ({ nodeId }));
  return { hits, nextCursor: hits.length === limit ? String(offset + limit) : null };
}

// --- snippets (§34.30 M3) ----------------------------------------------------------
//
// The snippet is computed in JS over the node's derived plaintext — the same
// text extractSearchPlaintext put in the index — rather than through the SQL
// snippet() function: the FTS5 build's snippet works, but the stock sql.js
// FTS4 build emits the column index into the output and misplaces its
// markers (verified against the shipped wasm), and offsets() differs in
// unit between FTS4 (bytes) and FTS5 (tokens). One JS implementation is
// byte-identical on both backends and testable without a MATCH query.

export interface SearchSnippetMatch {
  start: number;
  length: number;
}

export interface SearchSnippet {
  /** The excerpt (whitespace-normalized tokens, ellipsis at cut points). */
  text: string;
  /** Match spans, char offsets into `text`. */
  matches: SearchSnippetMatch[];
}

const SNIPPET_TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

/**
 * Excerpt around the densest cluster of query-term matches in one node's
 * indexed plaintext. Prefix semantics mirror the MATCH query (a token
 * matches when a query term is its case-insensitive prefix). Returns null
 * when the node is unknown or carries no match.
 */
export function searchSnippet(
  db: StoreDatabase,
  nodeId: string,
  query: string,
  opts?: { maxTokens?: number; ellipsis?: string },
): SearchSnippet | null {
  const terms = matchTerms(query).map((t) => t.toLowerCase());
  if (terms.length === 0) return null;
  const row = db.prepare("SELECT content FROM node WHERE id = ?").get(nodeId) as
    | { content: string }
    | undefined;
  if (!row) return null;
  const plaintext = extractSearchPlaintext(db, row.content, nodeId);
  const tokens: Array<{ start: number; end: number }> = [];
  SNIPPET_TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SNIPPET_TOKEN_PATTERN.exec(plaintext)) !== null) {
    tokens.push({ start: match.index, end: match.index + match[0].length });
  }
  if (tokens.length === 0) return null;
  const isHit = (token: { start: number; end: number }) =>
    terms.some((term) => plaintext.slice(token.start, token.end).toLowerCase().startsWith(term));
  if (!tokens.some(isHit)) return null;

  const maxTokens = Math.max(1, opts?.maxTokens ?? 24);
  const ellipsis = opts?.ellipsis ?? "…";
  // Densest fixed-width window; ties keep the earliest (stable scan).
  let bestStart = 0;
  let bestCount = -1;
  for (let i = 0; i < tokens.length; i++) {
    const end = Math.min(i + maxTokens, tokens.length);
    let count = 0;
    for (let k = i; k < end; k++) if (isHit(tokens[k]!)) count++;
    if (count > bestCount) {
      bestCount = count;
      bestStart = i;
    }
  }
  const windowEnd = Math.min(bestStart + maxTokens, tokens.length);
  const lead = bestStart > 0;
  const trail = windowEnd < tokens.length;

  // Rebuild the excerpt from the original plaintext, preserving the gaps
  // exactly, so match spans stay char-accurate against the returned text.
  let text = lead ? ellipsis : "";
  const matches: SearchSnippetMatch[] = [];
  for (let i = bestStart; i < windowEnd; i++) {
    if (i > bestStart) text += plaintext.slice(tokens[i - 1]!.end, tokens[i]!.start);
    const start = text.length;
    text += plaintext.slice(tokens[i]!.start, tokens[i]!.end);
    if (isHit(tokens[i]!)) matches.push({ start, length: tokens[i]!.end - tokens[i]!.start });
  }
  if (trail) text += ellipsis;
  return { text, matches };
}

// --- cross-backend restore (FTS module mismatch) -------------------------------
//
// Server-produced snapshots carry an FTS5 search_index (better-sqlite3), which
// stock sql.js (FTS4-only) can neither query nor maintain — every search and
// every reindex throws "no such module: fts5". The index is derived state, so
// the fix is to detect the mismatch at restore time and rebuild the table
// with the locally compiled module, reindexing from node name + content.

/**
 * True when a trivial query against search_index succeeds with the locally
 * compiled fts modules. False covers both a missing module (cross-backend
 * snapshot) and a missing/corrupt table — both are rebuilt the same way.
 */
export function isSearchIndexQueryable(db: StoreDatabase): boolean {
  try {
    db.prepare("SELECT content FROM search_index LIMIT 1").get();
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the search_index virtual table WITHOUT requiring its fts module.
 * The shadow tables are plain tables (normal DROP); the virtual table's own
 * sqlite_master row is then removed directly (writable_schema) because
 * `DROP TABLE search_index` would re-resolve the missing module and throw.
 * The caller must re-open the database afterwards — the connection's schema
 * cache is stale after direct sqlite_master edits.
 */
export function dropSearchIndex(db: StoreDatabase): void {
  db.exec(`
    DROP TABLE IF EXISTS search_index_data;
    DROP TABLE IF EXISTS search_index_idx;
    DROP TABLE IF EXISTS search_index_config;
    DROP TABLE IF EXISTS search_index_docsize;
    DROP TABLE IF EXISTS search_index_content;
    DROP TABLE IF EXISTS search_index_segments;
    DROP TABLE IF EXISTS search_index_segdir;
    DROP TABLE IF EXISTS search_index_stat;
  `);
  try {
    db.exec("DROP TABLE IF EXISTS search_index");
  } catch {
    db.exec("PRAGMA writable_schema=ON");
    db.exec("DELETE FROM sqlite_master WHERE type='table' AND name='search_index'");
    db.exec("PRAGMA writable_schema=OFF");
  }
}

/**
 * Reindex every active node from its stored name + content (derived plaintext
 * via reindexNode). Wraps the scan in a transaction; the docid map is cleared
 * first because the rowids it references belonged to the dropped table.
 */
export function reindexAllSearch(db: StoreDatabase): void {
  const run = db.transaction(() => {
    db.exec("DELETE FROM search_index_docid");
    const rows = db.prepare("SELECT id FROM node WHERE is_active = 1").all() as { id: string }[];
    for (const row of rows) reindexNode(db, row.id);
  });
  run();
}
