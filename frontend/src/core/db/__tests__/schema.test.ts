import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createTestDatabase } from '../../__tests__/helpers';
import { queryOne } from '../sqlite';

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

describe('schema', () => {
  it('creates node_stats, edge indexes, sync_outbox next_retry_at and migrates to user_version 10', async () => {
    const db = await createTestDatabase();

    const versionRow = db.exec('PRAGMA user_version')[0];
    const version = versionRow?.values[0]?.[0] as number;
    expect(version).toBe(10);

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
  });
});
