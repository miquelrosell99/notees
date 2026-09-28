/**
 * better-sqlite3 adapter (server/CLI default): wraps the native Database in
 * the minimal SqliteDB surface. Restore goes through a temp file —
 * better-sqlite3 has no deserialize — and the temp dir is removed when the
 * wrapping connection closes (the Store swaps connections on restore/reset).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import type { SqliteDB, SqliteStatement, StoreBackend } from "../db.js";

type RawDatabase = InstanceType<typeof Database>;

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
    return new BetterSqlite3Statement(this.raw.prepare(sql));
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
  // Foreign keys stay off (v1 precedent): the appliers maintain tree
  // integrity fail-loud, and out-of-order delivery must not hard-fail on
  // a missing parent. Placement invariants live in the CHECK constraints.
}

/** StoreBackend over better-sqlite3 at ``path`` (":memory:" for tests). */
export function betterSqlite3Backend(path = ":memory:"): StoreBackend {
  const open = (): BetterSqlite3DB => {
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
      const db = new BetterSqlite3DB(new Database(file), dir);
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
