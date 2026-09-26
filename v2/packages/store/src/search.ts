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
 * Prefix-AND FTS query (v1 client search pattern): each whitespace term
 * becomes a bare prefix token, all terms ANDed. Bare tokens (not quoted
 * prefix phrases) are the intersection of the FTS4 and FTS5 query languages
 * — FTS5's `"term"*` quoted-phrase prefix is a silent no-match on FTS4
 * (stock sql.js). Non-alphanumeric characters are dropped per term: the
 * unicode61 tokenizer discards them either way, and bare tokens must not
 * carry FTS query syntax (quotes, parens, colons).
 */
export function buildMatchQuery(query: string): string | null {
  const terms = query
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((t) => t.length > 0);
  if (terms.length === 0) return null;
  return terms.map((t) => `${t}*`).join(" AND ");
}
