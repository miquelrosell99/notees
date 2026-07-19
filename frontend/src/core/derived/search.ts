import { type Database } from 'sql.js';
import { queryOne } from '../db/sqlite';

export function extractPlaintext(content: unknown[]): string {
  return content
    .map((child: unknown) => {
      const c = child as { type?: string; text?: string };
      if (c.type === 'text' && typeof c.text === 'string') {
        return c.text;
      }
      return '';
    })
    .join(' ');
}

export function reindexNode(db: Database, nodeId: string): void {
  const row = queryOne<{ content: string }>(db, 'SELECT content FROM node WHERE id = ?', [nodeId]);
  if (!row) return;

  const content = JSON.parse(row.content) as unknown[];
  const plaintext = extractPlaintext(content);

  if (plaintext.length === 0) {
    db.run('DELETE FROM search_index WHERE node_id = ?', [nodeId]);
    return;
  }

  db.run(
    `INSERT OR REPLACE INTO search_index(docid, node_id, content)
     VALUES ((SELECT docid FROM search_index WHERE node_id = ?), ?, ?)`,
    [nodeId, nodeId, plaintext],
  );
}
