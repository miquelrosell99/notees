/**
 * Minimal synchronous SQLite adapter surface, derived from what the store
 * actually calls. Two implementations ship in `./adapters/`:
 *
 *  - `better-sqlite3.ts` — server/CLI default (native, file-backed);
 *  - `sqljs.ts` — browser/WASM target (sql.js, in-memory).
 *
 * Only positional `?` parameters are supported (named params are not used
 * anywhere in the store). `get`/`all` row values are driver-native: both
 * adapters return plain objects with column-named keys.
 */

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDB {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  /** better-sqlite3 semantics: returns the wrapped function. */
  transaction<T>(fn: () => T): () => T;
  /** Full-database bytes (snapshot). Optional: backends that cannot dump. */
  serialize?(): Uint8Array;
  close?(): void;
}

/**
 * Connection factory for one store. Store re-opens the database on
 * restore/reset, which is adapter-specific (better-sqlite3 has no
 * deserialize, so restore writes a temp file; sql.js loads the exported
 * bytes into a fresh in-memory database).
 */
export interface StoreBackend {
  /** Fresh, empty database. Connection pragmas applied; schema NOT migrated. */
  open(): SqliteDB;
  /** Database initialized from snapshot bytes; NOT migrated (bytes carry user_version). */
  restore(bytes: Uint8Array): SqliteDB;
  /** Fresh database after dropping any prior storage (files or memory). */
  reset(): SqliteDB;
  /**
   * FTS module the backend was compiled with. The canonical schema uses
   * FTS5; the stock sql.js WASM build ships without FTS5, so that backend
   * builds the same docid-map search index with FTS4 (identical MATCH
   * syntax and unicode61 tokenizer).
   */
  ftsModule: "fts5" | "fts4";
}
