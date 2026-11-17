/**
 * better-sqlite3 adapter (server/CLI default): wraps the native Database in
 * the minimal SqliteDB surface. Restore goes through a temp file —
 * better-sqlite3 has no deserialize — and the temp dir is removed when the
 * wrapping connection closes (the Store swaps connections on restore/reset).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import nodeModule from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type Database from "better-sqlite3";

import type { SqliteDB, SqliteStatement, StoreBackend } from "../db.js";

type DatabaseClass = typeof Database;
type RawDatabase = InstanceType<DatabaseClass>;

/**
 * The native module loads LAZILY at first open: a top-level import would put
 * better-sqlite3 in the static module graph of every consumer bundle —
 * breaking standalone CLI commands (`notees --version`, `--help`) wherever
 * the native module is not provisioned beside the bundle, and breaking the
 * web worker's browser build (vite externalizes node:module: a named import
 * from that stub is a build error, while a default import is tolerated
 * because the browser never reaches this loader — the web store runs on the
 * sqlitewasm adapter). Store commands still require the native module
 * (install.sh and the pacman package provision it into the node_modules
 * beside the bundle). createRequire resolves from this module — or, once
 * inlined into a consumer bundle, from that bundle's own location, exactly
 * like the import did.
 */
let cachedDatabaseClass: DatabaseClass | undefined;
function databaseClass(): DatabaseClass {
  if (cachedDatabaseClass === undefined) {
    const mod = nodeModule.createRequire(import.meta.url)("better-sqlite3") as
      | DatabaseClass
      | { default: DatabaseClass };
    cachedDatabaseClass = "default" in mod ? mod.default : mod;
  }
  return cachedDatabaseClass;
}

/** Structural slice of better-sqlite3's Statement (its generic BindParameters spread does not accept unknown[]). */
interface RawStatement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

class BetterSqlite3Statement implements SqliteStatement {
  constructor(private readonly stmt: RawStatement) {}

  run(...params: unknown[]): { changes: number } {
    return { changes: Number(this.stmt.run(...params).changes) };
  }

  get(...params: unknown[]): unknown {
    return this.stmt.get(...params);
  }

  all(...params: unknown[]): unknown[] {
    return this.stmt.all(...params);
  }
}

export class BetterSqlite3DB implements SqliteDB {
  /**
   * Prepared-statement wrapper cache. better-sqlite3 natively caches the
   * underlying native statements, but every prepare() call used to allocate
   * a fresh JS wrapper (and re-hash the SQL string) — tens of wrappers per
   * applied envelope. The wrapper is stateless between calls, so caching it
   * is safe. Bounded: the store's distinct SQL is mostly static, but a few
   * appliers build dynamic placeholder lists; on overflow the map clears
   * and rebuilds rather than growing without bound.
   */
  private static readonly STMT_CACHE_CAP = 1000;
  private readonly stmtCache = new Map<string, BetterSqlite3Statement>();

  /**
   * @param raw    the wrapped native connection.
   * @param tempDir temp dir owned by this connection (temp-file restores);
   *                removed on close.
   */
  constructor(
    readonly raw: RawDatabase,
    private tempDir: string | null = null,
  ) {}

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    const cached = this.stmtCache.get(sql);
    if (cached !== undefined) return cached;
    const stmt = new BetterSqlite3Statement(this.raw.prepare(sql));
    if (this.stmtCache.size >= BetterSqlite3DB.STMT_CACHE_CAP) {
      this.stmtCache.clear();
    }
    this.stmtCache.set(sql, stmt);
    return stmt;
  }

  pragma(source: string, options?: { simple?: boolean }): unknown {
    return this.raw.pragma(source, options);
  }

  transaction<T>(fn: () => T): () => T {
    return this.raw.transaction(fn);
  }

  serialize(): Uint8Array {
    return this.raw.serialize();
  }

  close(): void {
    this.raw.close();
    if (this.tempDir !== null) {
      rmSync(this.tempDir, { recursive: true, force: true });
      this.tempDir = null;
    }
  }
}

function applyConnectionPragmas(db: RawDatabase): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  // Foreign keys stay off: the appliers maintain tree
  // integrity fail-loud, and out-of-order delivery must not hard-fail on
  // a missing parent. Placement invariants live in the CHECK constraints.
}

/** StoreBackend over better-sqlite3 at ``path`` (":memory:" for tests). */
export function betterSqlite3Backend(path = ":memory:"): StoreBackend {
  const open = (): BetterSqlite3DB => {
    const Database = databaseClass();
    const db = new BetterSqlite3DB(new Database(path));
    applyConnectionPragmas(db.raw);
    return db;
  };
  return {
    ftsModule: "fts5",
    open,
    restore(bytes) {
      const dir = mkdtempSync(join(tmpdir(), "notees-store-"));
      const file = join(dir, "restored.db");
      writeFileSync(file, bytes);
      const db = new BetterSqlite3DB(new (databaseClass())(file), dir);
      // The serialized bytes carry their own user_version; just re-apply
      // the connection pragmas for the new connection.
      applyConnectionPragmas(db.raw);
      return db;
    },
    reset() {
      if (path !== ":memory:") {
        for (const suffix of ["", "-wal", "-shm"]) {
          rmSync(path + suffix, { force: true });
        }
      }
      return open();
    },
  };
}
