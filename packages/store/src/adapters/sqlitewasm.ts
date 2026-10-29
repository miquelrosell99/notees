/**
 * sqlite-wasm adapter (browser/WASM target, third backend): the official
 * `@sqlite.org/sqlite-wasm` build behind the StoreBackend seam.
 *
 * Two modes:
 *
 *  - `memory` (Node/tests) — `:memory:` connections; restore stages the bytes
 *    through the wasm build's posix file layer and opens by name;
 *  - `opfs` (the web worker) — an `oo1.OpfsDb` over the OPFS VFS: the
 *    database PAGES live in OPFS and only the working set touches WASM
 *    memory, so a snapshot restore never holds the whole image in the heap
 *    (the restore-time memory cliff that OOM-crashed the headless smoke at
 *    live scale). Restore is staged async (the caller writes the bytes into
 *    the OPFS file, then the connection opens by name) — see
 *    `StoreBackend.restoreAsync`. Persistence is the VFS itself: the worker
 *    skips its whole-file export persist for this backend.
 *
 * The official build ships FTS5, so this backend declares `ftsModule "fts5"`
 * and the store's restore-time FTS repair path (store.ts) never fires for it.
 * The module is passed in (like sqljsBackend(SQL)) — this file imports no
 * package and stays bundler-agnostic; the worker entry inits the module and
 * passes its `locateFile` URL.
 *
 * Error shape mirrors the sql.js adapter: sqlite-wasm throws Errors without
 * a string `code`, so throws are tagged SQLITE_ERROR to keep the store's
 * error translation (isSqliteError / translateSqliteError, message-regex
 * based) working.
 */

import type { SnapshotStreamSource, SqliteDB, SqliteStatement, StoreBackend } from "../db.js";

/** Narrow structural surface of the `@sqlite.org/sqlite-wasm` module (the adapter never imports the package). */
export interface SqliteWasmModule {
  oo1: {
    DB: new (options?: { filename?: string; flags?: string; vfs?: string }) => SqliteWasmRawDb;
    /** Browser-only (absent in the Node build and without the OPFS VFS). */
    OpfsDb?: new (filename: string, flags?: string) => SqliteWasmRawDb;
  };
  capi: {
    sqlite3_js_db_export(db: SqliteWasmRawDb, schema?: string): Uint8Array;
    sqlite3_js_posix_create_file(name: string, data: Uint8Array | ArrayBuffer, dataLen?: number): void;
    sqlite3_vfs_find(name: string): unknown;
  };
}

/** Narrow structural surface of an oo1 database connection. */
export interface SqliteWasmRawDb {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteWasmRawStmt;
  changes(): number;
  close(): void;
}

export interface SqliteWasmRawStmt {
  bind(values: readonly unknown[]): unknown;
  step(): boolean;
  get(columnNameMode?: object): Record<string, unknown>;
  finalize(): void;
}

function tagSqliteError(error: unknown): never {
  if (error instanceof Error) {
    if (!("code" in error)) {
      try {
        (error as { code?: string }).code = "SQLITE_ERROR";
      } catch {
        // Non-extensible error object: leave it untagged.
      }
    }
    throw error;
  }
  throw new Error(String(error));
}

function bindParams(params: unknown[]): unknown[] {
  // sqlite-wasm rejects undefined bindings; the store never sends them, but
  // map defensively (SQLite semantics: unbound -> NULL).
  return params.map((p) => (p === undefined ? null : p));
}

class SqliteWasmStatement implements SqliteStatement {
  constructor(
    private readonly db: SqliteWasmRawDb,
    private readonly sql: string,
  ) {}

  run(...params: unknown[]): { changes: number } {
    const stmt = this.db.prepare(this.sql);
    try {
      if (params.length > 0) stmt.bind(bindParams(params));
      stmt.step();
      return { changes: this.db.changes() };
    } catch (error) {
      tagSqliteError(error);
    } finally {
      stmt.finalize();
    }
  }

  get(...params: unknown[]): unknown {
    const stmt = this.db.prepare(this.sql);
    try {
      if (params.length > 0) stmt.bind(bindParams(params));
      if (!stmt.step()) return undefined;
      return stmt.get({});
    } catch (error) {
      tagSqliteError(error);
    } finally {
      stmt.finalize();
    }
  }

  all(...params: unknown[]): unknown[] {
    const stmt = this.db.prepare(this.sql);
    try {
      if (params.length > 0) stmt.bind(bindParams(params));
      const rows: unknown[] = [];
      while (stmt.step()) rows.push(stmt.get({}));
      return rows;
    } catch (error) {
      tagSqliteError(error);
    } finally {
      stmt.finalize();
    }
  }
}

class SqliteWasmDB implements SqliteDB {
  constructor(
    readonly raw: SqliteWasmRawDb,
    private readonly sqlite3: SqliteWasmModule,
  ) {}

  exec(sql: string): void {
    try {
      this.raw.exec(sql);
    } catch (error) {
      tagSqliteError(error);
    }
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteWasmStatement(this.raw, sql);
  }

  pragma(source: string, options?: { simple?: boolean }): unknown {
    try {
      const stmt = this.raw.prepare(`PRAGMA ${source}`);
      try {
        if (!stmt.step()) return undefined;
        if (options?.simple) {
          const row = stmt.get({});
          return Object.values(row)[0];
        }
        return [stmt.get({})];
      } finally {
        stmt.finalize();
      }
    } catch (error) {
      tagSqliteError(error);
    }
  }

  transaction<T>(fn: () => T): () => T {
    return () => {
      this.exec("SAVEPOINT notees_tx");
      try {
        const result = fn();
        this.exec("RELEASE notees_tx");
        return result;
      } catch (error) {
        this.exec("ROLLBACK TO notees_tx");
        this.exec("RELEASE notees_tx");
        throw error;
      }
    };
  }

  serialize(): Uint8Array {
    try {
      return this.sqlite3.capi.sqlite3_js_db_export(this.raw);
    } catch (error) {
      tagSqliteError(error);
    }
  }

  close(): void {
    this.raw.close();
  }
}

/** Drop every user object + reset the schema version — a synchronous "empty file" for reset(). */
function wipeAllObjects(db: SqliteWasmRawDb): void {
  const stmt = db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'");
  const drops: string[] = [];
  try {
    while (stmt.step()) {
      const { type, name } = stmt.get({}) as { type: string; name: string };
      drops.push(`DROP ${type} IF EXISTS "${name.replace(/"/g, '""')}"`);
    }
  } finally {
    stmt.finalize();
  }
  for (const drop of drops) db.exec(drop);
  db.exec("PRAGMA user_version = 0");
}

export type SqliteWasmBackendOptions =
  | { kind: "memory" }
  | {
      kind: "opfs";
      /** The OPFS file name (e.g. `<workspaceId>.db`) the VFS opens. */
      fileName: string;
      /**
       * Staged restore: write the snapshot bytes into the OPFS file; the
       * backend then opens it by name (restore never holds the image in the
       * WASM heap).
       */
      writeFile: (bytes: Uint8Array) => Promise<void>;
      /**
       * Snapshot-upload source: resolve the OPFS file handle. After a WAL
       * checkpoint the main file IS the consistent image, and the returned
       * File is a point-in-time snapshot (getFile freezes content), so the
       * upload streams it lazily instead of serializing the whole database
       * through the WASM heap. Absent → uploads fall back to serialize().
       */
      openFile?: () => Promise<SnapshotFile>;
    };

/** Minimal file-like snapshot source (an OPFS File is structurally compatible). */
export interface SnapshotFile {
  readonly size: number;
  stream(): ReadableStream<Uint8Array>;
}

/** Restore staging counter: memory-mode restores get a unique posix file. */
let restoreCounter = 0;

/**
 * StoreBackend over the official sqlite-wasm build. `memory` serves
 * Node/tests; `opfs` is the web worker's persistent backend (see the
 * file header for the memory model).
 */
export function sqliteWasmBackend(sqlite3: SqliteWasmModule, options: SqliteWasmBackendOptions): StoreBackend {
  if (options.kind === "opfs") {
    const openOpfs = (): SqliteWasmRawDb => {
      const OpfsDb = sqlite3.oo1.OpfsDb;
      if (OpfsDb === undefined) {
        throw new Error("sqlite-wasm backend: oo1.OpfsDb is unavailable (OPFS VFS not installed)");
      }
      return new OpfsDb(options.fileName);
    };
    return {
      ftsModule: "fts5",
      open: () => new SqliteWasmDB(openOpfs(), sqlite3),
      restore: () => {
        throw new Error(
          "sqlite-wasm opfs backend: restore is staged async — use Store.restoreAsync " +
            "(the OPFS file write is async; the sync restore would need the whole image in memory)",
        );
      },
      restoreAsync: async (bytes) => {
        await options.writeFile(bytes);
        return new SqliteWasmDB(openOpfs(), sqlite3);
      },
      snapshotStream: async (): Promise<SnapshotStreamSource | null> => {
        if (options.openFile === undefined) return null;
        const db = openOpfs();
        // WAL checkpoint so the MAIN file is the complete image (a snapshot
        // upload must not depend on a -wal sibling the relay would never
        // see). The File the opener returns is a point-in-time snapshot, so
        // the stream stays consistent even if a write lands after this call.
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const file = await options.openFile();
        return {
          byteLength: file.size,
          stream: () => file.stream(),
        };
      },
      reset: () => {
        const db = openOpfs();
        wipeAllObjects(db);
        return new SqliteWasmDB(db, sqlite3);
      },
    };
  }
  return {
    ftsModule: "fts5",
    open: () => new SqliteWasmDB(new sqlite3.oo1.DB(), sqlite3),
    restore: (bytes) => {
      const name = `/notees-restore-${++restoreCounter}.db`;
      sqlite3.capi.sqlite3_js_posix_create_file(name, bytes);
      return new SqliteWasmDB(new sqlite3.oo1.DB({ filename: name }), sqlite3);
    },
    reset: () => new SqliteWasmDB(new sqlite3.oo1.DB(), sqlite3),
  };
}
