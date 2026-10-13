/**
 * FTS5 maintenance (port of `derived/search.py`, FTS4 -> FTS5). Rows are
 * addressed by rowid through the search_index_docid map, so reindex and
 * delete are O(log n) instead of a full docstore scan per statement.
 */

import type { SqliteStatement, StoreDatabase } from "./types.js";
import { extractContentPlaintext, extractSearchPlaintext } from "./content.js";

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
  // node's text-ish property values fold in too. Diacritics fold at INDEX
  // TIME (schema v19): the MATCH query terms are folded in JS before they
  // reach SQLite, and the stock sql.js FTS4 tokenizer cannot fold for us
  // (no remove_diacritics support — verified), so folding lives here and
  // in compileSearchQuery, one mirror pair. Snippets recompute from the
  // UNfolded source, so excerpts keep their real characters.
  const indexed = foldSearchText(extractSearchPlaintext(db, row.content, nodeId));
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
 * The maximal letter/digit runs of a query. Exposed for the snippet
 * helper, which needs the same term splitting without the FTS syntax.
 */
export function matchTerms(query: string): string[] {
  return query
    .trim()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/**
 * Query modes (owner 2026-10-13):
 *  - default   — prefix tokens, multi-term OR, priority tiers + partials
 *  - exact     — the whole query wrapped in quotes (`"gmi dental"`): only
 *                rows whose title/text contains that EXACT substring
 *                (case-insensitive); no prefix, no ordered, no partials
 *  - starts    — a leading caret (`^gmi dental`): only rows whose
 *                title/text STARTS WITH the query (case-insensitive)
 *
 * A quoted phrase INSIDE a larger query (`"brown fox" jump`) is not the
 * exact mode — it stays an exact-adjacency clause ANDed with the rest.
 */
type SearchMode = "default" | "exact" | "starts";

interface SearchQueryInfo {
  match: string;
  /** The trimmed lowercased query (mode needle, quotes/caret stripped). */
  normalized: string;
  /** The lowercased maximal letter/digit runs — the token-match needles. */
  terms: string[];
  mode: SearchMode;
}

/** Split a query into (mode, needle text) — the mode prefix/stripping. */
function parseSearchMode(raw: string): { mode: SearchMode; needle: string } | null {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const inner = trimmed.slice(1, -1).trim();
    return inner === "" ? null : { mode: "exact", needle: inner };
  }
  if (trimmed.startsWith("^")) {
    const inner = trimmed.slice(1).trim();
    return inner === "" ? null : { mode: "starts", needle: inner };
  }
  return { mode: "default", needle: trimmed };
}

/**
 * Diacritic folding that mirrors the search_index tokenizer
 * (`unicode61 remove_diacritics 2`, store schema v19): every combining
 * mark is stripped, so `peru` and "Perú" compare equal in the tier scorer
 * exactly when the FTS match folds them. Exported for the snippet helper
 * and tests.
 */
export function foldSearchText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "");
}

function compileSearchQuery(query: string): (SearchQueryInfo & { phraseCount: number }) | null {
  const parsed = parseSearchMode(query);
  if (parsed === null) return null;
  // The needle folds here (diacritics) BEFORE the MATCH query is built:
  // index-time folding (reindexNode) and query folding are the one mirror
  // pair that makes `peru` match "Perú" on both FTS modules.
  const needle = foldSearchText(parsed.needle);
  // The candidate MATCH: modes AND their terms (every term must be present
  // for the substring/start filter to pass); default ORs bare terms so
  // partial matches enter the candidate set.
  const compiled = compileMatch(needle, parsed.mode === "default" ? "or" : "and");
  if (compiled === null) return null;
  const terms = matchTerms(needle).map((t) => t.toLowerCase());
  if (terms.length === 0) return null;
  return {
    match: compiled.match,
    phraseCount: compiled.phraseCount,
    normalized: needle.toLowerCase(),
    terms,
    mode: parsed.mode,
  };
}

/**
 * Prefix FTS query with quoted-phrase support: each maximal run of
 * letters/digits OUTSIDE double quotes becomes a bare prefix token, each
 * `"quoted"` segment an exact FTS phrase (valid MATCH syntax on FTS4 and
 * FTS5 alike — verified against the shipped sql.js wasm; FTS5's `"term"*`
 * phrase-PREFIX stays off the table because FTS4 silently no-matches it).
 * An unterminated quote degrades to plain text. Splitting at every
 * non-alphanumeric boundary mirrors the unicode61 tokenizer (which splits
 * indexed text at the same boundaries), so "11607-1" compiles to
 * `11607* OR 1*` and matches the indexed tokens instead of merging into a
 * nonexistent "116071". Bare tokens must not carry FTS query syntax
 * (quotes, parens, colons), which is why the quoted segments are extracted
 * before the prefix pass runs.
 *
 * Bare-term combination (priority ranking, owner 2026-10-13): multiple
 * bare terms OR together (`(gmi* OR dental*)`) — every hit carries at
 * least one term, and the ranker orders whole-query matches first, partial
 * matches last. A single bare term stays a lone clause, and quoted phrases
 * AND with the bare group, so `"brown fox" jump` keeps its strict
 * adjacency + term semantics.
 */
export function buildMatchQuery(query: string): string | null {
  const parsed = parseSearchMode(query);
  if (parsed === null) return null;
  // Folded needle, mirroring compileSearchQuery (the index folds at insert).
  return compileMatch(foldSearchText(parsed.needle), parsed.mode === "default" ? "or" : "and")?.match ?? null;
}

/**
 * The MATCH query plus its phrase count — matchinfo('x') on FTS4 is laid
 * out per PHRASE (a quoted multi-word phrase is one; every bare token is
 * one, OR group included), and the FTS4 hit scorer sizes the blob with it.
 * `bareCombine` ORs bare terms in the default mode (partial candidates)
 * and ANDs them in the exact/starts modes (every term must be present
 * before the substring/start filter can pass).
 */
function compileMatch(
  query: string,
  bareCombine: "or" | "and",
): { match: string; phraseCount: number } | null {
  const clauses: string[] = [];
  const bare: string[] = [];
  const unquoted: string[] = [];
  let phraseCount = 0;
  const pattern = /"([^"]*)"/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(query)) !== null) {
    unquoted.push(query.slice(last, match.index));
    last = match.index + match[0].length;
    const terms = matchTerms(match[1]!);
    if (terms.length > 0) {
      clauses.push(`"${terms.join(" ")}"`);
      phraseCount += 1;
    }
  }
  unquoted.push(query.slice(last));
  for (const term of matchTerms(unquoted.join(" "))) bare.push(`${term}*`);
  phraseCount += bare.length;
  if (bare.length > 0) {
    clauses.push(bare.length === 1 ? bare[0]! : `(${bare.join(bareCombine === "or" ? " OR " : " AND ")})`);
  }
  if (clauses.length === 0) return null;
  return { match: clauses.join(" AND "), phraseCount };
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

// --- ranked search ---------------------------------------------------------------
//
// Priority ranking (owner 2026-10-13): the FTS match is only the CANDIDATE
// GENERATOR. Every hit is rescored in JS against the query with a tier
// model, and the tier orders — both modules produce the same tier order
// because the scorer is one shared implementation over the same rows:
//
//   0  exact query (case-insensitive substring, diacritics folded) in a
//      MAIN node's title
//   1  exact query in a block's text (parented non-class content)
//   2  every term, in order but not necessarily adjacent, in a main
//      node's title
//   3  every term, in order, in any node's text (title + property values)
//   4  the node's FIRST PARENT's title matches (exact substring or ordered)
//      — a block surfaces under a matching page
//   5  partial: some terms only, more matched terms first; the whole query
//      as an ordered subsequence (fuzzy) lifts a partial above plain ones
//   6  fuzzy rescue: the whole query as an ordered subsequence over
//      main-node titles — scanned only when nothing reached the literal
//      tiers (Capacities "find by intent", owner 2026-10-13)
//
// Diacritics fold everywhere (store schema v19: folding is INDEX-TIME —
// reindexNode strips combining marks from the indexed plaintext and
// compileSearchQuery folds the MATCH terms, one mirror pair; the stock
// sql.js FTS4 tokenizer has no remove_diacritics support — verified
// against the shipped wasm), so `peru` matches "Perú" in the FTS match
// and every tier alike.
//
// Within a tier: match position / term span (earlier / tighter first),
// then text length (shorter first), then the FTS score (bm25 on FTS5 —
// ascending, most negative first; matchinfo hit count on the stock sql.js
// FTS4, negated), then recency (updated_at DESC, NULLs last), then node
// id — fully deterministic on both adapters, near-identical ordering.
//
// Candidate volume: FTS5 caps the bm25-ranked candidate scan at 1000 rows
// UNIONed with an exact-phrase arm (exact matches can never be capped
// away); FTS4 cannot ORDER BY rank and scans the full match set, exactly
// like the old relevance-only ranker did.
//
// Aliases: a node alias (the `aliased_node_id` column, many-to-one FROM
// the alias page) whose own title matches the query also contributes its
// TERMINAL as a candidate, so the canonical page appears when searched by
// an alias name. Alias text VALUES need nothing extra — they are property
// values and already ride the indexed row (tier 3).
//
// The module is a property of the DATABASE, not the backend: a
// cross-backend snapshot restore can park an FTS4 index inside
// better-sqlite3 (still queryable, so the repair path keeps it), which is
// why it is detected from sqlite_master and cached per connection (restore
// swaps the connection, invalidating the cache).

export interface RankedSearchHit {
  nodeId: string;
}

export interface RankedSearchPage {
  hits: RankedSearchHit[];
  /**
   * Offset cursor for the next page (opaque to callers), or null when this
   * page exhausted the match set. Ranking is deterministic (tier, span,
   * length, FTS score, recency, id), so an offset cursor pages a stable
   * order; a concurrent edit may shift rows at worst, never corrupt.
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

/** One candidate row: the node's fundamentals + its two texts. */
interface SearchCandidateRow {
  nodeId: string;
  updatedAt: string | null;
  isClass: number;
  parentId: string | null;
  presentAsMain: number;
  aliasedNodeId: string | null;
  /** Serialized contentAst — the title source. */
  rawContent: string;
  /** The indexed plaintext (title + property values + asset names). */
  indexedText: string | null;
  /** Normalized FTS score, smaller = better (see the module header). */
  ftsRank: number;
}

/** The candidate SELECT — identical on both modules; __FTS_TAIL__ carries
 *  the module-specific score projection(s). */
const CANDIDATE_SELECT = `
  SELECT d.node_id AS nodeId, n.updated_at AS updatedAt, n.is_class AS isClass,
         n.parent_id AS parentId, n.present_as_main AS presentAsMain,
         n.aliased_node_id AS aliasedNodeId, n.content AS rawContent,
         s.content AS indexedText__FTS_TAIL__
  FROM search_index s
  JOIN search_index_docid d ON d.docid = s.rowid
  JOIN node n ON n.id = d.node_id AND n.is_active = 1`;

const TERMINAL_SELECT = `
  SELECT n.id AS nodeId, n.updated_at AS updatedAt, n.is_class AS isClass,
         n.parent_id AS parentId, n.present_as_main AS presentAsMain,
         n.aliased_node_id AS aliasedNodeId, n.content AS rawContent,
         s.content AS indexedText, 0 AS fts
  FROM node n
  LEFT JOIN search_index_docid d ON d.node_id = n.id
  LEFT JOIN search_index s ON s.rowid = d.docid
  WHERE n.id = ? AND n.is_active = 1`;

/**
 * Supplementary candidate source for tier 4 (first-parent-name matching):
 * children of nodes whose FTS row matches the query. The parent's TITLE
 * check still happens in the scorer — a parent whose property values match
 * but whose title does not is generated here and dropped there, keeping
 * the tier strictly "first parent name".
 */
const PARENT_CANDIDATE_SELECT = `
  SELECT child.id AS nodeId, child.updated_at AS updatedAt, child.is_class AS isClass,
         child.parent_id AS parentId, child.present_as_main AS presentAsMain,
         child.aliased_node_id AS aliasedNodeId, child.content AS rawContent,
         s.content AS indexedText__FTS_TAIL__
  FROM node child
  JOIN node p ON p.id = child.parent_id
  JOIN search_index_docid d ON d.docid IS NOT NULL AND d.node_id = p.id
  JOIN search_index s ON s.rowid = d.docid
  WHERE child.is_active = 1`;

/** Recency comparison: newer first; NULL timestamps (never updated) last. */
function compareRecency(a: string | null, b: string | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return a < b ? 1 : a > b ? -1 : 0;
}

// --- the tier scorer ------------------------------------------------------------

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

function tokenizeLower(text: string): string[] {
  return text.toLowerCase().match(TOKEN_PATTERN) ?? [];
}

/**
 * Ordered-subsequence fuzzy score (the Capacities "find by intent" rescue,
 * owner 2026-10-13), or null when the query is not a subsequence of the
 * target. Word-start and consecutive matches score higher; shorter targets
 * win ties (the small length penalty). Ported from the palette's fuzzyScore
 * so both surfaces score identically.
 */
export function fuzzySubsequenceScore(query: string, target: string): number | null {
  if (query === "") return 0;
  let score = 0;
  let ti = 0;
  let lastMatch = -2;
  for (let qi = 0; qi < query.length; qi += 1) {
    const ch = query[qi]!;
    let found = -1;
    while (ti < target.length) {
      if (target[ti] === ch) {
        found = ti;
        break;
      }
      ti += 1;
    }
    if (found === -1) return null;
    score += 1;
    if (found === 0 || /[\s\-_/.@·]/.test(target[found - 1]!)) score += 3;
    if (found === lastMatch + 1) score += 2;
    lastMatch = found;
    ti = found + 1;
  }
  return score - target.length * 0.01;
}

/**
 * Greedy in-order first positions of every term as a TOKEN PREFIX (the
 * same prefix semantics as the MATCH query): null when any term has no
 * prefix-match. "gmi dental" against "gmi dental implantology" yields
 * [0, 1]; against "gmi south dental" [0, 2] — order without adjacency.
 */
function orderedTermPositions(tokens: string[], terms: string[]): number[] | null {
  const positions: number[] = [];
  let from = 0;
  for (const term of terms) {
    let found = -1;
    for (let i = from; i < tokens.length; i++) {
      if (tokens[i]!.startsWith(term)) {
        found = i;
        break;
      }
    }
    if (found < 0) return null;
    positions.push(found);
    from = found + 1;
  }
  return positions;
}

interface TierScore {
  tier: number;
  /** Literal position or ordered span — earlier / tighter first. */
  subA: number;
  /** The matched text's length — shorter (more direct) first. */
  subB: number;
}

interface ScoreContext {
  db: StoreDatabase;
  query: SearchQueryInfo;
  /** Only rows that reach tier 4 pay the parent lookup. */
  parentStmt: SqliteStatement;
}

/**
 * Score one candidate against the query. `titleLower`/`titleTokens`/
 * `textTokens` are precomputed; the parent title is fetched lazily
 * (tier 4 only). Returns null when the candidate violates the query mode
 * (exact / starts) — mode-nonconforming rows are dropped, never ranked.
 */
function scoreCandidate(
  row: SearchCandidateRow,
  ctx: ScoreContext,
  titleLower: string,
  titleTokens: string[],
  textTokens: string[],
): TierScore | null {
  const { normalized, terms, mode } = ctx.query;
  const isMain = row.isClass === 1 || row.parentId === null || row.presentAsMain === 1;
  const textLower = row.indexedText === null ? "" : row.indexedText.toLowerCase();

  if (mode === "exact") {
    const titleLit = titleLower.indexOf(normalized);
    if (isMain && titleLit >= 0) return { tier: 0, subA: titleLit, subB: titleLower.length };
    const textLit = textLower.indexOf(normalized);
    if (textLit >= 0) return { tier: 1, subA: textLit, subB: textLower.length };
    return null;
  }
  if (mode === "starts") {
    if (isMain && titleLower.startsWith(normalized)) {
      return { tier: 0, subA: 0, subB: titleLower.length };
    }
    if (textLower.startsWith(normalized)) return { tier: 1, subA: 0, subB: textLower.length };
    return null;
  }

  const titleLit = titleLower.indexOf(normalized);
  if (isMain && titleLit >= 0) return { tier: 0, subA: titleLit, subB: titleLower.length };

  const textLit = textLower.indexOf(normalized);
  if (!isMain && textLit >= 0) return { tier: 1, subA: textLit, subB: textLower.length };

  const titleOrder = orderedTermPositions(titleTokens, terms);
  if (isMain && titleOrder !== null) {
    return { tier: 2, subA: titleOrder[titleOrder.length - 1]! - titleOrder[0]!, subB: titleLower.length };
  }
  const textOrder = orderedTermPositions(textTokens, terms);
  if (textOrder !== null) {
    return { tier: 3, subA: textOrder[textOrder.length - 1]! - textOrder[0]!, subB: textLower.length };
  }

  if (row.parentId !== null) {
    const parent = ctx.parentStmt.get(row.parentId) as { content: string } | undefined;
    if (parent !== undefined) {
      const parentLower = foldSearchText(extractContentPlaintext(ctx.db, parent.content).toLowerCase());
      const parentLit = parentLower.indexOf(normalized);
      const parentOrder =
        parentLit >= 0 ? null : orderedTermPositions(tokenizeLower(parentLower), terms);
      if (parentLit >= 0 || parentOrder !== null) {
        return {
          tier: 4,
          subA: parentLit >= 0 ? parentLit : parentOrder![parentOrder!.length - 1]! - parentOrder![0]!,
          subB: parentLower.length,
        };
      }
    }
  }

  // Partial: count the terms with a prefix-match anywhere in the node's own
  // text (FTS guaranteed ≥ 1 for matched rows; alias-expanded terminals
  // may carry none and sink to the bottom of the tier). The whole query as
  // an ordered subsequence (fuzzy) lifts a partial above plain partials —
  // the Capacities "find by intent" signal inside the candidate set.
  const matched = terms.filter(
    (t) => textTokens.some((tok) => tok.startsWith(t)) || titleTokens.some((tok) => tok.startsWith(t)),
  ).length;
  const fuzzy =
    fuzzySubsequenceScore(normalized, titleLower) ?? fuzzySubsequenceScore(normalized, textLower);
  return { tier: 5, subA: -(matched * 100_000 + Math.round((fuzzy ?? 0) * 100)), subB: 0 };
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

/**
 * Ranked FTS search over active nodes: priority tiers first (exact
 * main-title, exact block, ordered terms, parent title, partial), FTS
 * score, recency, and node id inside a tier.
 */
export function searchNodes(db: StoreDatabase, query: string, limit: number): RankedSearchHit[] {
  return searchNodesPage(db, query, limit).hits;
}

/**
 * Cursor-paginated ranked search: the same deterministic order
 * as searchNodes, sliced one page at a time. The returned cursor is the
 * opaque next-page argument (null = done).
 */
export function searchNodesPage(
  db: StoreDatabase,
  query: string,
  limit: number,
  cursor: string | null = null,
): RankedSearchPage {
  const info = compileSearchQuery(query);
  if (info === null) return { hits: [], nextCursor: null };
  const offset = parseSearchCursor(cursor);

  const module = searchIndexModule(db);
  // FTS5's rank is selected straight into `fts` (bm25, smaller = better).
  // FTS4 has no rank column: matchinfo('x') lands in `mi` and is scored in
  // JS (matchinfoHitScore), negated so both modules compare smaller-is-better.
  const selectSql =
    module === "fts5"
      ? CANDIDATE_SELECT.replace("__FTS_TAIL__", ", s.rank AS fts")
      : CANDIDATE_SELECT.replace("__FTS_TAIL__", ", 0 AS fts, matchinfo(search_index, 'x') AS mi");

  // Candidate volume: common-term queries match thousands of rows and deep
  // partials are noise, so FTS5 caps the bm25-ranked scan — UNIONed with an
  // exact-phrase arm (all the query's terms adjacent) so exact/adjacency
  // matches can never fall out through a weak bm25 score. FTS4 cannot
  // ORDER BY rank (no such column, verified) and rides the full match set
  // like it always did; the tier scorer orders the survivors identically.
  const CANDIDATE_CAP = 1000;
  const phraseMatch = info.terms.length >= 2 ? `"${info.terms.join(" ")}"` : null;
  const stmtSql =
    module === "fts5"
      ? phraseMatch !== null
        ? `WITH primary_hits AS (${selectSql}\n  WHERE search_index MATCH ?\n  ORDER BY s.rank ASC\n  LIMIT ${CANDIDATE_CAP}),\n     phrase_hits AS (${selectSql}\n  WHERE search_index MATCH ?\n  LIMIT ${CANDIDATE_CAP})\nSELECT * FROM primary_hits\nUNION\nSELECT * FROM phrase_hits`
        : `${selectSql}\n  WHERE search_index MATCH ?\n  ORDER BY s.rank ASC\n  LIMIT ${CANDIDATE_CAP}`
      : `${selectSql}\n  WHERE search_index MATCH ?`;
  const stmt = db.prepare(stmtSql);
  const rawRows = (
    phraseMatch !== null && module === "fts5"
      ? stmt.all(info.match, phraseMatch)
      : stmt.all(info.match)
  ) as Array<Record<string, unknown>>;
  const phraseCount = info.phraseCount;

  // Tier-4 (first-parent-name) candidates: children of matching parents.
  // Default mode only — the exact/starts modes constrain matching to the
  // node's own text. A parent whose property values match but whose title
  // does not is generated here and dropped by the scorer's title check.
  const parentSql =
    module === "fts5"
      ? PARENT_CANDIDATE_SELECT.replace("__FTS_TAIL__", ", s.rank AS fts")
      : PARENT_CANDIDATE_SELECT.replace("__FTS_TAIL__", ", 0 AS fts, matchinfo(search_index, 'x') AS mi");
  const parentStmtSql =
    module === "fts5"
      ? `${parentSql}\n  AND search_index MATCH ?\n  ORDER BY s.rank ASC\n  LIMIT 500`
      : `${parentSql}\n  AND search_index MATCH ?`;
  const parentRows =
    info.mode === "default"
      ? (db.prepare(parentStmtSql).all(info.match) as Array<Record<string, unknown>>)
      : [];

  const ctx: ScoreContext = {
    db,
    query: info,
    parentStmt: db.prepare("SELECT content FROM node WHERE id = ?"),
  };
  const terminalStmt = db.prepare(TERMINAL_SELECT);

  const seen = new Set<string>();
  const scored: Array<{ row: SearchCandidateRow; score: TierScore }> = [];

  const pushRow = (raw: Record<string, unknown>, ftsRank: number): void => {
    const row = raw as unknown as SearchCandidateRow;
    row.ftsRank = ftsRank;
    if (seen.has(row.nodeId)) return;
    seen.add(row.nodeId);
    // Folded (diacritic-stripped) haystacks — the v19 tokenizer folds the
    // FTS side; folding here keeps substring/token tiers consistent.
    const titleLower = foldSearchText(extractContentPlaintext(db, row.rawContent).toLowerCase());
    const titleTokens = tokenizeLower(titleLower);
    const textTokens = tokenizeLower(foldSearchText(row.indexedText ?? ""));
    const score = scoreCandidate(row, ctx, titleLower, titleTokens, textTokens);
    if (score !== null) scored.push({ row, score });
  };

  const ftsRankOf = (raw: Record<string, unknown>): number =>
    module === "fts5" ? (raw.fts as number) : -matchinfoHitScore(raw.mi, phraseCount);

  for (const raw of rawRows) pushRow(raw, ftsRankOf(raw));
  for (const raw of parentRows) pushRow(raw, ftsRankOf(raw));

  // Alias expansion: a matching alias PAGE also contributes its TERMINAL —
  // the canonical page appears when searched by an alias name. The chain
  // is walked like Store.resolveAlias (revisit = the starting id unchanged,
  // generous depth cap), so an alias-of-an-alias still lands on the
  // canonical page.
  for (const { row } of [...scored]) {
    if (row.aliasedNodeId === null) continue;
    if (row.isClass !== 1 && row.parentId !== null && row.presentAsMain !== 1) continue;
    let current = row;
    for (let depth = 0; depth < 16 && current.aliasedNodeId !== null; depth++) {
      const nextId = current.aliasedNodeId;
      if (seen.has(nextId)) break;
      const terminal = terminalStmt.get(nextId) as Record<string, unknown> | undefined;
      if (terminal === undefined) break;
      pushRow(terminal, 0);
      current = terminal as unknown as SearchCandidateRow;
    }
  }

  // Fuzzy rescue (default mode, owner 2026-10-13): when nothing reached the
  // literal tiers, scan every MAIN node's raw content for an
  // ordered-subsequence match (`gmi dntl` finds "GMI Dental…"). The raw
  // content JSON carries the title text verbatim, so the query's
  // characters appear in order exactly when the title matches (JSON
  // syntax can only add characters, never block a subsequence). Blocks
  // stay off the rescue surface — titles are the intent surface. The scan
  // is gated to ≥3-char queries and to the no-literal-hit case, so the
  // common path never pays for it.
  if (
    info.mode === "default" &&
    info.normalized.length >= 3 &&
    !scored.some((entry) => entry.score.tier <= 1)
  ) {
    const rescueRows = db
      .prepare(
        `SELECT id AS nodeId, content AS rawContent, updated_at AS updatedAt,
                is_class AS isClass, parent_id AS parentId,
                present_as_main AS presentAsMain, aliased_node_id AS aliasedNodeId
         FROM node
         WHERE is_active = 1 AND (is_class = 1 OR parent_id IS NULL OR present_as_main = 1)`,
      )
      .all() as Array<Record<string, unknown>>;
    for (const raw of rescueRows) {
      const nodeId = raw.nodeId as string;
      if (seen.has(nodeId)) continue;
      const fuzzy = fuzzySubsequenceScore(
        info.normalized,
        foldSearchText(String(raw.rawContent ?? "").toLowerCase()),
      );
      if (fuzzy === null) continue;
      seen.add(nodeId);
      const row = {
        nodeId,
        updatedAt: (raw.updatedAt as string | null) ?? null,
        isClass: raw.isClass as number,
        parentId: (raw.parentId as string | null) ?? null,
        presentAsMain: raw.presentAsMain as number,
        aliasedNodeId: (raw.aliasedNodeId as string | null) ?? null,
        rawContent: raw.rawContent as string,
        indexedText: null,
        ftsRank: 0,
      } as SearchCandidateRow;
      scored.push({ row, score: { tier: 6, subA: -Math.round(fuzzy * 100), subB: 0 } });
    }
  }

  scored.sort((a, b) => {
    const s = a.score;
    const t = b.score;
    return (
      s.tier - t.tier ||
      s.subA - t.subA ||
      s.subB - t.subB ||
      a.row.ftsRank - b.row.ftsRank ||
      compareRecency(a.row.updatedAt, b.row.updatedAt) ||
      (a.row.nodeId < b.row.nodeId ? -1 : 1)
    );
  });

  const hits = scored.slice(offset, offset + limit).map(({ row }) => ({ nodeId: row.nodeId }));
  return { hits, nextCursor: hits.length === limit ? String(offset + limit) : null };
}

// --- snippets ---------------------------------------------------------------------
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
  const terms = matchTerms(query).map((t) => foldSearchText(t.toLowerCase()));
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
  // Folded hit check (diacritics, mirroring the v19 tokenizer) over the
  // ORIGINAL plaintext — the excerpt keeps its real characters.
  const isHit = (token: { start: number; end: number }) =>
    terms.some((term) =>
      foldSearchText(plaintext.slice(token.start, token.end).toLowerCase()).startsWith(term),
    );
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
