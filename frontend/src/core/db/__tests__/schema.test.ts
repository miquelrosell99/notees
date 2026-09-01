import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import initSqlJs from 'sql.js';
import { createTestDatabase } from '../../__tests__/helpers';
import { createSchema } from '../schema';
import { queryOne } from '../sqlite';

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

describe('schema', () => {
  it('creates node icon/color columns, node_stats, node_link, edge indexes, sync_outbox next_retry_at, node_child_order PK and migrates to user_version 17', async () => {
    const db = await createTestDatabase();

    const versionRow = db.exec('PRAGMA user_version')[0];
    const version = versionRow?.values[0]?.[0] as number;
    expect(version).toBe(17);

    const schemaIndex = queryOne<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_property_value_schema'"
    );
    expect(schemaIndex).toBeDefined();

    const watermarkTable = queryOne<{ sql: string }>(
      db,
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sync_watermark'"
    );
    expect(watermarkTable?.sql).toMatch(/cursor_seq\s+INTEGER/i);

    const nodeTable = queryOne<{ sql: string }>(
      db,
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'node'"
    );
    expect(nodeTable?.sql).toMatch(/icon\s+TEXT/i);
    expect(nodeTable?.sql).toMatch(/color\s+TEXT/i);
    expect(nodeTable?.sql).toMatch(/text_content\s+TEXT/i);

    const nodeStats = queryOne<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'node_stats'"
    );
    expect(nodeStats).toBeDefined();

    const nodeLink = queryOne<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'node_link'"
    );
    expect(nodeLink).toBeDefined();

    const sourceIndex = queryOne<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_edge_source_type'"
    );
    expect(sourceIndex).toBeDefined();

    const targetIndex = queryOne<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_edge_target_type'"
    );
    expect(targetIndex).toBeDefined();

    const workspaceIndex = queryOne<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_node_workspace'"
    );
    expect(workspaceIndex).toBeDefined();

    const childOrderTable = queryOne<{ sql: string }>(
      db,
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'node_child_order'"
    );
    expect(childOrderTable?.sql).toMatch(/PRIMARY KEY\s*\(\s*parent_id\s*,\s*child_id\s*\)/i);
  });

  it('deduplicates node_child_order rows during migration to version 11', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();

    // Simulate an old table without a primary key and insert duplicates.
    db.exec(`
      CREATE TABLE node_child_order (
        parent_id TEXT NOT NULL,
        child_id TEXT NOT NULL,
        position TEXT NOT NULL
      );
      INSERT INTO node_child_order (parent_id, child_id, position) VALUES
        ('parent-1', 'child-a', '0000000000'),
        ('parent-1', 'child-a', '0000000001'),
        ('parent-1', 'child-b', '0000000002'),
        ('parent-2', 'child-c', '0000000000');
    `);

    // createSchema runs CREATE TABLE IF NOT EXISTS (which skips the existing
    // table) and then migrateSchema, which recreates the table with a PK and
    // deduplicates existing rows.
    createSchema(db);

    const rows = db.exec('SELECT parent_id, child_id FROM node_child_order ORDER BY parent_id, child_id');
    const values = rows[0]?.values as [string, string][] | undefined ?? [];
    expect(values).toEqual([
      ['parent-1', 'child-a'],
      ['parent-1', 'child-b'],
      ['parent-2', 'child-c'],
    ]);

    const childOrderTable = queryOne<{ sql: string }>(
      db,
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'node_child_order'"
    );
    expect(childOrderTable?.sql).toMatch(/PRIMARY KEY\s*\(\s*parent_id\s*,\s*child_id\s*\)/i);
  });
});

describe('schema migration to version 16 (node.text_content)', () => {
  it('adds text_content and backfills it from content with json_tree semantics', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();

    // Simulate a pre-v16 database: node table without text_content, version 15.
    db.exec(`
      CREATE TABLE node (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        class_ids TEXT NOT NULL DEFAULT '[]',
        parent_id TEXT,
        content TEXT NOT NULL DEFAULT '[]',
        icon TEXT,
        color TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT,
        updated_at TEXT,
        created_by TEXT,
        updated_by TEXT
      );
      PRAGMA user_version = 15;
    `);
    const paragraph = JSON.stringify([
      { type: 'paragraph', children: [{ type: 'text', text: 'Hello world' }] },
    ]);
    const wrapperInner = JSON.stringify([
      { type: 'paragraph', children: [{ type: 'text', text: 'real text' }] },
    ]);
    const wrapper = JSON.stringify([{ type: 'text', text: wrapperInner }]);
    db.run(
      "INSERT INTO node (id, workspace_id, kind, content) VALUES ('n1', 'ws', 'page', ?)",
      [paragraph]
    );
    db.run(
      "INSERT INTO node (id, workspace_id, kind, content) VALUES ('n2', 'ws', 'block', ?)",
      [wrapper]
    );
    db.run("INSERT INTO node (id, workspace_id, kind, content) VALUES ('n3', 'ws', 'block', '[]')");

    createSchema(db);

    const versionRow = db.exec('PRAGMA user_version')[0];
    expect(versionRow?.values[0]?.[0]).toBe(17);

    const rows = queryOne<{ text_content: string | null }>(
      db,
      "SELECT text_content FROM node WHERE id = 'n1'"
    );
    expect(rows?.text_content).toBe('Hello world');

    const wrapperRow = queryOne<{ text_content: string | null }>(
      db,
      "SELECT text_content FROM node WHERE id = 'n2'"
    );
    expect(wrapperRow?.text_content).toBe(wrapperInner);

    const emptyRow = queryOne<{ text_content: string | null }>(
      db,
      "SELECT text_content FROM node WHERE id = 'n3'"
    );
    expect(emptyRow?.text_content).toBeNull();
  });
});

describe('schema migration to version 17 (idx_property_value_schema)', () => {
  it('adds the property_schema_id index to existing databases', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();

    // Simulate a pre-v17 database at version 16 (property_value exists from the
    // initial schema, but without the new index).
    db.exec('PRAGMA user_version = 16');

    createSchema(db);

    const versionRow = db.exec('PRAGMA user_version')[0];
    expect(versionRow?.values[0]?.[0]).toBe(17);

    const index = queryOne<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_property_value_schema'"
    );
    expect(index).toBeDefined();
  });
});
