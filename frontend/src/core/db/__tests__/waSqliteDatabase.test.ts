import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import type { Database } from 'sql.js';
import {
  createWaSqliteDatabase,
  isWaSqliteDatabase,
  verifyMigratedDatabase,
  type WaSqliteDatabase,
} from '../waSqliteDatabase';
import { createSchema } from '../schema';
import { queryOne, queryAll, transaction } from '../sqlite';

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

async function createTestDb(name: string, initialBytes?: Uint8Array): Promise<WaSqliteDatabase> {
  return createWaSqliteDatabase({ name, vfs: 'memory', initialBytes });
}

describe('waSqliteDatabase (memory vfs)', () => {
  it('run/exec round trip with sql.js {columns, values} result shape', async () => {
    const db = await createTestDb('run-exec');
    try {
      db.run('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, score REAL)');
      db.run('INSERT INTO t(name, score) VALUES (?, ?)', ['alpha', 1.5]);
      db.run('INSERT INTO t(name, score) VALUES (?, ?)', ['beta', 2.5]);

      const results = db.exec('SELECT id, name, score FROM t ORDER BY id');
      expect(results).toHaveLength(1);
      expect(results[0].columns).toEqual(['id', 'name', 'score']);
      expect(results[0].values).toEqual([
        [1, 'alpha', 1.5],
        [2, 'beta', 2.5],
      ]);

      // sql.js semantics: statements producing zero rows contribute no entry.
      expect(db.exec('SELECT id FROM t WHERE id = -1')).toEqual([]);

      // Multi-statement exec: every statement runs; only row-producing ones
      // appear in the results.
      const multi = db.exec(`
        INSERT INTO t(name, score) VALUES ('gamma', 3.5);
        SELECT name FROM t WHERE id = 3;
        UPDATE t SET score = 9 WHERE id = 3;
      `);
      expect(multi).toHaveLength(1);
      expect(multi[0].values).toEqual([['gamma']]);
    } finally {
      db.close();
    }
  });

  it('prepare + bind + step + getAsObject works with the repo queryOne/queryAll helpers', async () => {
    const db = await createTestDb('prepare');
    try {
      db.run('CREATE TABLE item(id INTEGER PRIMARY KEY, label TEXT, qty INTEGER, blob BLOB)');
      db.run('INSERT INTO item(label, qty, blob) VALUES (?, ?, ?)', [
        'widget',
        7,
        new Uint8Array([1, 2, 3]),
      ]);
      db.run('INSERT INTO item(label, qty) VALUES (?, ?)', ['gadget', 3]);

      // Cast through the sql.js Database type, exactly like the integration
      // boundary will, and run the repo's own helpers against it.
      const sqlJsDb = db as unknown as Database;

      const one = queryOne<{ id: number; label: string; qty: number }>(
        sqlJsDb,
        'SELECT id, label, qty FROM item WHERE label = ?',
        ['widget']
      );
      expect(one).toEqual({ id: 1, label: 'widget', qty: 7 });

      const all = queryAll<{ label: string }>(sqlJsDb, 'SELECT label FROM item ORDER BY id');
      expect(all.map((r) => r.label)).toEqual(['widget', 'gadget']);

      const missing = queryOne(sqlJsDb, 'SELECT id FROM item WHERE id = ?', [999]);
      expect(missing).toBeUndefined();

      // Blobs round-trip as Uint8Array, NULLs as null.
      const row = queryOne<{ blob: Uint8Array; missing: null }>(
        sqlJsDb,
        'SELECT blob, NULL AS missing FROM item WHERE id = 1'
      );
      expect(Array.from(row!.blob)).toEqual([1, 2, 3]);
      expect(row!.missing).toBeNull();

      // 64-bit integers beyond 32 bits.
      const big = queryOne<{ v: number }>(sqlJsDb, 'SELECT ? AS v', [5_000_000_001]);
      expect(big!.v).toBe(5_000_000_001);
    } finally {
      db.close();
    }
  });

  it('transaction semantics: BEGIN/COMMIT persists, ROLLBACK undoes', async () => {
    const db = await createTestDb('tx');
    const sqlJsDb = db as unknown as Database;
    try {
      db.run('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)');

      transaction(sqlJsDb, () => {
        db.run('INSERT INTO t(v) VALUES (?)', ['committed']);
      });
      expect(queryOne(sqlJsDb, 'SELECT v FROM t')).toEqual({ v: 'committed' });

      expect(() =>
        transaction(sqlJsDb, () => {
          db.run('INSERT INTO t(v) VALUES (?)', ['rolled-back']);
          throw new Error('boom');
        })
      ).toThrow('boom');

      const rows = queryAll<{ v: string }>(sqlJsDb, 'SELECT v FROM t ORDER BY id');
      expect(rows.map((r) => r.v)).toEqual(['committed']);
    } finally {
      db.close();
    }
  });

  it('getRowsModified reflects the last UPDATE/DELETE', async () => {
    const db = await createTestDb('rows-modified');
    try {
      db.run('CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER)');
      db.run("INSERT INTO t(v) VALUES (1), (2), (3), (4)");
      expect(db.getRowsModified()).toBe(4);

      db.run('UPDATE t SET v = v * 10 WHERE id >= 3');
      expect(db.getRowsModified()).toBe(2);

      db.run('DELETE FROM t WHERE id = 1');
      expect(db.getRowsModified()).toBe(1);
    } finally {
      db.close();
    }
  });

  it('export() round trip: export -> initialBytes -> data present', async () => {
    const source = await createTestDb('export-source');
    let bytes: Uint8Array;
    try {
      source.run('CREATE TABLE t(id INTEGER PRIMARY KEY, payload TEXT)');
      source.run('INSERT INTO t(payload) VALUES (?)', ['persist-me']);
      bytes = source.export();
      expect(bytes.byteLength).toBeGreaterThan(0);
      // SQLite database file magic header.
      expect(new TextDecoder().decode(bytes.slice(0, 16))).toBe('SQLite format 3\0');
    } finally {
      source.close();
    }

    const restored = await createTestDb('export-restored', bytes);
    try {
      const rows = restored.exec('SELECT payload FROM t');
      expect(rows[0].values).toEqual([['persist-me']]);
    } finally {
      restored.close();
    }

    // initialBytes never overwrites an existing database: seeding the same
    // logical name again keeps the current content.
    const again = await createTestDb('export-restored', bytes);
    try {
      again.run('INSERT INTO t(payload) VALUES (?)', ['second']);
      const rows = again.exec('SELECT payload FROM t ORDER BY id');
      expect(rows[0].values).toEqual([['persist-me'], ['second']]);
    } finally {
      again.close();
    }
  });

  it('mirrors a realistic repo query: JSON column + indexed lookup', async () => {
    const db = await createTestDb('node-mirror');
    try {
      db.exec(`
        CREATE TABLE node(
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          parent_id TEXT,
          content TEXT,
          properties TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX idx_node_parent ON node(parent_id);
        CREATE INDEX idx_node_type ON node(type);
      `);

      const insert = db.prepare(
        'INSERT INTO node(id, type, parent_id, content, properties) VALUES (?, ?, ?, ?, ?)'
      );
      try {
        insert.run(['page-1', 'page', null, 'Inbox', JSON.stringify({ icon: '📥' })]);
        insert.run(['block-1', 'block', 'page-1', 'Buy milk', JSON.stringify({ checked: false })]);
        insert.run(['block-2', 'block', 'page-1', 'Call mom', JSON.stringify({ checked: true })]);
        insert.run(['block-3', 'block', 'page-2', 'Orphan', '{}']);
      } finally {
        insert.free();
      }

      // Indexed parent lookup (the shape used by derived child-order queries).
      const children = db.exec('SELECT id FROM node WHERE parent_id = ? ORDER BY id', ['page-1']);
      expect(children[0].values).toEqual([['block-1'], ['block-2']]);

      // JSON extraction from a properties column.
      const checked = db.exec(
        "SELECT id FROM node WHERE json_extract(properties, '$.checked') = 1"
      );
      expect(checked[0].values).toEqual([['block-2']]);

      const typeCount = db.exec('SELECT COUNT(*) FROM node WHERE type = ?', ['block']);
      expect(typeCount[0].values[0][0]).toBe(3);
    } finally {
      db.close();
    }
  });

  it('runs createSchema on a fresh database and serves FTS4/FTS5 queries', async () => {
    // Regression: the stock wa-sqlite dist wasm ships without any FTS module
    // ("no such module: fts4"), which broke workspace open the moment a
    // statement touched the FTS4 search_index. The vendored build at
    // ../wa-sqlite-fts/ must keep FTS3/4/5 compiled in.
    const db = await createTestDb('fts');
    try {
      createSchema(db as unknown as Database);

      db.run('INSERT INTO search_index (node_id, content) VALUES (?, ?)', [
        'n1',
        'buy milk and eggs',
      ]);
      db.run('INSERT INTO search_index (node_id, content) VALUES (?, ?)', ['n2', 'call mom']);
      const prefix = db.exec('SELECT node_id FROM search_index WHERE content MATCH ?', ['mil*']);
      expect(prefix[0].values).toEqual([['n1']]);
      // matchinfo('pcx') is the ranking blob search.ts scores with.
      const ranked = db.exec("SELECT matchinfo(search_index, 'pcx') FROM search_index WHERE content MATCH ?", [
        'milk',
      ]);
      expect(ranked[0].values).toHaveLength(1);

      // FTS5 is compiled in for a future search migration.
      db.exec('CREATE VIRTUAL TABLE ft5 USING fts5(content)');
      db.run('INSERT INTO ft5 (content) VALUES (?)', ['hello world']);
      expect(db.exec("SELECT rowid FROM ft5 WHERE ft5 MATCH 'hello'")[0].values).toEqual([[1]]);
    } finally {
      db.close();
    }
  });

  it('isWaSqliteDatabase distinguishes the adapter from other objects', async () => {
    const db = await createTestDb('type-guard');
    try {
      expect(isWaSqliteDatabase(db)).toBe(true);
      expect(isWaSqliteDatabase({ run: () => ({}) })).toBe(false);
      expect(isWaSqliteDatabase(null)).toBe(false);
      expect(isWaSqliteDatabase(undefined)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('replaceWithSnapshot swaps the whole database image and stays usable', async () => {
    // Build the snapshot image in a separate database.
    const snapshotSource = await createTestDb('snapshot-source');
    let snapshot: Uint8Array;
    try {
      snapshotSource.run('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)');
      snapshotSource.run("INSERT INTO t(v) VALUES ('new-1'), ('new-2')");
      snapshotSource.run('CREATE TABLE added(id INTEGER PRIMARY KEY)');
      snapshot = snapshotSource.export();
    } finally {
      snapshotSource.close();
    }

    const db = await createTestDb('snapshot-target');
    try {
      db.run('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)');
      db.run("INSERT INTO t(v) VALUES ('old-1'), ('old-2'), ('old-3')");
      db.run('CREATE TABLE stale(id INTEGER PRIMARY KEY)');
      expect(isWaSqliteDatabase(db)).toBe(true);

      await db.replaceWithSnapshot(snapshot);

      // New contents are present, stale rows and tables are gone.
      const rows = db.exec('SELECT v FROM t ORDER BY id');
      expect(rows[0].values).toEqual([['new-1'], ['new-2']]);
      expect(db.exec('SELECT id FROM added')).toEqual([]);
      expect(() => db.exec('SELECT id FROM stale')).toThrow();

      // run/prepare/export all keep working against the new contents.
      db.run("INSERT INTO t(v) VALUES (?)", ['post-replace']);
      const stmt = db.prepare('SELECT COUNT(*) AS n FROM t');
      try {
        expect(stmt.step()).toBe(true);
        expect(stmt.getAsObject()).toEqual({ n: 3 });
      } finally {
        stmt.free();
      }
      expect(db.getRowsModified()).toBe(1);

      const reexported = db.export();
      const restored = await createTestDb('snapshot-restored', reexported);
      try {
        expect(restored.exec('SELECT v FROM t ORDER BY id')[0].values).toEqual([
          ['new-1'],
          ['new-2'],
          ['post-replace'],
        ]);
      } finally {
        restored.close();
      }
    } finally {
      db.close();
    }
  });

  it('replaceWithSnapshot throws when the database is closed', async () => {
    const db = await createTestDb('snapshot-closed');
    db.run('CREATE TABLE t(id INTEGER PRIMARY KEY)');
    const bytes = db.export();
    db.close();
    await expect(db.replaceWithSnapshot(bytes)).rejects.toThrow('Database closed');
  });

  it('replaceWithSnapshot rejects invalid images before touching the database', async () => {
    const db = await createTestDb('snapshot-garbage');
    try {
      db.run('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)');
      db.run("INSERT INTO t(v) VALUES ('still-here')");

      // Too small to be a database image.
      await expect(db.replaceWithSnapshot(new Uint8Array(10))).rejects.toThrow(
        /too small to be a SQLite database image/
      );

      // Right size, wrong magic header.
      const garbage = new Uint8Array(4096).fill(0xab);
      await expect(db.replaceWithSnapshot(garbage)).rejects.toThrow(
        /missing the 16-byte "SQLite format 3" header/
      );

      // The healthy database was never closed or modified.
      expect(db.exec('SELECT v FROM t')[0].values).toEqual([['still-here']]);
      db.run("INSERT INTO t(v) VALUES (?)", ['after-reject']);
      expect(db.exec('SELECT COUNT(*) FROM t')[0].values[0][0]).toBe(2);
    } finally {
      db.close();
    }
  });

  it('verifyMigratedDatabase passes after a normal initialBytes migration', async () => {
    const source = await createTestDb('verify-source');
    let bytes: Uint8Array;
    try {
      source.run('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)');
      source.run("INSERT INTO t(v) VALUES ('migrated')");
      source.run('PRAGMA user_version = 7');
      bytes = source.export();
    } finally {
      source.close();
    }

    const db = await createTestDb('verify-target', bytes);
    try {
      const result = await verifyMigratedDatabase(db, bytes);
      expect(result).toEqual({ ok: true });
      expect(db.exec('PRAGMA user_version')[0].values[0][0]).toBe(7);
      expect(db.exec('SELECT v FROM t')[0].values).toEqual([['migrated']]);
    } finally {
      db.close();
    }
  });

  it('verifyMigratedDatabase fails when the source user_version does not match', async () => {
    const source = await createTestDb('verify-doctored-source');
    let bytes: Uint8Array;
    try {
      source.run('CREATE TABLE t(id INTEGER PRIMARY KEY)');
      source.run('PRAGMA user_version = 7');
      bytes = source.export();
    } finally {
      source.close();
    }

    const db = await createTestDb('verify-doctored-target', bytes);
    try {
      // Doctor a copy of the source image: user_version 7 -> 42 at header
      // bytes 60-63 (big-endian uint32).
      const doctored = bytes.slice();
      new DataView(doctored.buffer, doctored.byteOffset).setUint32(60, 42, false);

      const result = await verifyMigratedDatabase(db, doctored);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('user_version regression');
      expect(result.reason).toContain('42');
      expect(result.reason).toContain('7');
    } finally {
      db.close();
    }
  });

  it('verifyMigratedDatabase returns no-source-bytes without initialBytes', async () => {
    const db = await createTestDb('verify-no-bytes');
    try {
      db.run('CREATE TABLE t(id INTEGER PRIMARY KEY)');
      expect(await verifyMigratedDatabase(db, undefined)).toEqual({
        ok: true,
        reason: 'no-source-bytes',
      });
      expect(await verifyMigratedDatabase(db, new Uint8Array(10))).toEqual({
        ok: true,
        reason: 'no-source-bytes',
      });
    } finally {
      db.close();
    }
  });
});
