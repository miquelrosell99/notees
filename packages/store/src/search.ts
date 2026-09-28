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
  const row = db.prepare("SELECT name, content FROM node WHERE id = ?").get(nodeId) as
    | { name: string | null; content: string }
    | undefined;
  if (!row) return;
  const plaintext = extractSearchPlaintext(db, row.content);
  // Title search (SCHEMA.md deviation register, RECONCILED 2026-09-26): the
  // indexed text is the stored name plus the content plaintext, so a page is
  // findable by name; null names contribute nothing.
  const indexed = row.name ? `${row.name} ${plaintext}`.trim() : plaintext;
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
 * Prefix-AND FTS query (v1 client search pattern): each maximal run of
 * letters/digits becomes a bare prefix token, all terms ANDed. Splitting at
 * every non-alphanumeric boundary mirrors the unicode61 tokenizer (which
 * splits indexed text at the same boundaries), so "11607-1" compiles to
 * `11607* AND 1*` and matches the indexed tokens instead of merging into a
 * nonexistent "116071". Bare tokens (not quoted prefix phrases) are the
 * intersection of the FTS4 and FTS5 query languages — FTS5's `"term"*` quoted
 * phrase prefix is a silent no-match on FTS4 (stock sql.js) — and bare tokens
 * must not carry FTS query syntax (quotes, parens, colons).
 */
export function buildMatchQuery(query: string): string | null {
  const terms = query
    .trim()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return null;
  return terms.map((t) => `${t}*`).join(" AND ");
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
