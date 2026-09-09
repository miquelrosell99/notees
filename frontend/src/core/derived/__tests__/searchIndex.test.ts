import { describe, it, expect } from 'vitest';
import { createTestDatabase } from '../../__tests__/helpers';
import { reindexNode, removeSearchIndexEntry } from '../search';
import { queryOne, queryAll } from '../../db/sqlite';

/**
 * The search_index FTS4 table cannot index its notindexed node_id column, so
 * all maintenance is addressed by docid through the search_index_docid map
 * (a node_id-filtered statement on the FTS table is a full docstore scan).
 * These tests pin the map contract: reindex replaces instead of duplicating,
 * and removals clean both tables.
 */

function insertNode(db: Awaited<ReturnType<typeof createTestDatabase>>, id: string, text: string): void {
  const content = JSON.stringify([{ type: 'paragraph', children: [{ type: 'text', text }] }]);
  db.run("INSERT INTO node (id, workspace_id, kind, content) VALUES (?, 'ws', 'block', ?)", [id, content]);
}

function updateNodeContent(
  db: Awaited<ReturnType<typeof createTestDatabase>>,
  id: string,
  text: string
): void {
  const content = JSON.stringify([{ type: 'paragraph', children: [{ type: 'text', text }] }]);
  db.run('UPDATE node SET content = ? WHERE id = ?', [content, id]);
}

function indexRows(
  db: Awaited<ReturnType<typeof createTestDatabase>>,
  nodeId: string
): Array<{ node_id: string }> {
  return queryAll<{ node_id: string }>(db, 'SELECT node_id FROM search_index WHERE node_id = ?', [nodeId]);
}

describe('reindexNode (docid-mapped FTS maintenance)', () => {
  it('inserts a findable row and keeps the docid map in sync', async () => {
    const db = await createTestDatabase();
    insertNode(db, 'n1', 'buy milk and eggs');

    reindexNode(db, 'n1');

    expect(indexRows(db, 'n1')).toHaveLength(1);
    const map = queryOne<{ docid: number }>(
      db,
      'SELECT docid FROM search_index_docid WHERE node_id = ?',
      ['n1']
    );
    expect(map).toBeDefined();
    const viaMatch = queryAll<{ node_id: string }>(
      db,
      "SELECT node_id FROM search_index WHERE content MATCH 'mil*'"
    );
    expect(viaMatch.map((r) => r.node_id)).toEqual(['n1']);
  });

  it('replaces the existing row on reindex instead of duplicating it', async () => {
    const db = await createTestDatabase();
    insertNode(db, 'n1', 'buy milk');

    reindexNode(db, 'n1');
    updateNodeContent(db, 'n1', 'call mom');
    reindexNode(db, 'n1');
    reindexNode(db, 'n1');

    expect(indexRows(db, 'n1')).toHaveLength(1);
    expect(
      queryAll(db, "SELECT node_id FROM search_index WHERE content MATCH 'milk'")
    ).toHaveLength(0);
    expect(
      queryAll<{ node_id: string }>(db, "SELECT node_id FROM search_index WHERE content MATCH 'mom'")
    ).toHaveLength(1);
  });

  it('removes the entry and map row when content becomes empty', async () => {
    const db = await createTestDatabase();
    insertNode(db, 'n1', 'buy milk');
    reindexNode(db, 'n1');
    expect(indexRows(db, 'n1')).toHaveLength(1);

    db.run("UPDATE node SET content = '[]' WHERE id = 'n1'");
    reindexNode(db, 'n1');

    expect(indexRows(db, 'n1')).toHaveLength(0);
    expect(
      queryOne(db, 'SELECT docid FROM search_index_docid WHERE node_id = ?', ['n1'])
    ).toBeUndefined();
  });

  it('removeSearchIndexEntry deletes both the FTS row and the map row', async () => {
    const db = await createTestDatabase();
    insertNode(db, 'n1', 'buy milk');
    insertNode(db, 'n2', 'call mom');
    reindexNode(db, 'n1');
    reindexNode(db, 'n2');

    removeSearchIndexEntry(db, 'n1');

    expect(indexRows(db, 'n1')).toHaveLength(0);
    expect(indexRows(db, 'n2')).toHaveLength(1);
    expect(
      queryOne(db, 'SELECT docid FROM search_index_docid WHERE node_id = ?', ['n1'])
    ).toBeUndefined();
  });

  it('no-ops cleanly for a node that was never indexed', async () => {
    const db = await createTestDatabase();
    expect(() => removeSearchIndexEntry(db, 'never-seen')).not.toThrow();
  });
});

describe('schema v21 (search_index_docid backfill)', () => {
  it('backfills the docid map from an existing search_index', async () => {
    const db = await createTestDatabase();
    insertNode(db, 'n1', 'buy milk');
    reindexNode(db, 'n1');

    // Simulate a pre-v21 database: populated search_index, empty map.
    db.exec('DELETE FROM search_index_docid');
    db.exec('PRAGMA user_version = 20');

    const { createSchema } = await import('../../db/schema');
    createSchema(db);

    expect(db.exec('PRAGMA user_version')[0].values[0][0]).toBe(21);
    const map = queryOne<{ docid: number }>(
      db,
      'SELECT docid FROM search_index_docid WHERE node_id = ?',
      ['n1']
    );
    expect(map).toBeDefined();

    // Post-backfill reindex still replaces instead of duplicating.
    updateNodeContent(db, 'n1', 'feed the cat');
    reindexNode(db, 'n1');
    expect(indexRows(db, 'n1')).toHaveLength(1);
  });
});
