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
  const plaintext = extractSearchPlaintext(db, row.content);
  if (!plaintext) {
    removeSearchIndexEntry(db, nodeId);
    return;
  }
  db.prepare(
    "DELETE FROM search_index WHERE rowid = (SELECT docid FROM search_index_docid WHERE node_id = ?)",
  ).run(nodeId);
  db.prepare("INSERT INTO search_index (content) VALUES (?)").run(plaintext);
  // last_insert_rowid() is the docid of the row just inserted on this
  // connection; keep the map in sync for the next reindex/delete.
  db.prepare(
    "INSERT OR REPLACE INTO search_index_docid (node_id, docid) VALUES (?, last_insert_rowid())",
  ).run(nodeId);
}

/**
 * Prefix-AND FTS5 query (v1 client search pattern): each whitespace term
 * becomes a quoted prefix token, all terms ANDed.
 */
export function buildMatchQuery(query: string): string | null {
  const terms = query
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '""'))
    .filter((t) => t.length > 0);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"*`).join(" AND ");
}
