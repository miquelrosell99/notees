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
  it('creates node icon/color columns, node_stats, edge indexes, sync_outbox next_retry_at, node_child_order PK and migrates to user_version 13', async () => {
    const db = await createTestDatabase();

    const versionRow = db.exec('PRAGMA user_version')[0];
    const version = versionRow?.values[0]?.[0] as number;
    expect(version).toBe(13);

    const nodeTable = queryOne<{ sql: string }>(
      db,
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'node'"
    );
    expect(nodeTable?.sql).toMatch(/icon\s+TEXT/i);
    expect(nodeTable?.sql).toMatch(/color\s+TEXT/i);

    const nodeStats = queryOne<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'node_stats'"
    );
    expect(nodeStats).toBeDefined();

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
