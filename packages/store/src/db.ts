/**
 * Minimal synchronous SQLite adapter surface, derived from what the store
 * actually calls. Three implementations ship in `./adapters/`:
 *
 *  - `better-sqlite3.ts` — server/CLI default (native, file-backed);
 *  - `sqljs.ts` — browser/WASM target (sql.js, in-memory);
 *  - `sqlitewasm.ts` — browser/WASM target (official @sqlite.org/sqlite-wasm;
 *    the OPFS-VFS mode pages from OPFS instead of holding the whole image in
 *    the WASM heap, and restores are staged async).
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
/**
 * A lazily-readable snapshot image: `byteLength` is the raw (uncompressed)
 * size — a conservative bound for pre-flight upload-limit checks — and each
 * `stream()` call opens a fresh read over the same consistent image.
 *
 * `ReadableStream` is referenced as the AMBIENT global (no import): node
 * builds resolve it via @types/node, browsers via lib.dom — the emitted d.ts
 * keeps the bare name so each consumer gets its own.
 */
export interface SnapshotStreamSource {
  byteLength: number;
  stream(): ReadableStream<Uint8Array>;
}

export interface StoreBackend {
  /** Fresh, empty database. Connection pragmas applied; schema NOT migrated. */
  open(): SqliteDB;
  /** Database initialized from snapshot bytes; NOT migrated (bytes carry user_version). */
  restore(bytes: Uint8Array): SqliteDB;
  /**
   * Staged restore for backends whose storage write is asynchronous (the
   * sqlite-wasm OPFS VFS: the bytes land in the OPFS file, then the
   * connection opens by name). Callers with an async context
   * (Store.restoreAsync) prefer this over the sync restore.
   */
  restoreAsync?(bytes: Uint8Array): Promise<SqliteDB>;
  /**
   * Streaming snapshot source — backends whose image lives in a file readable
   * without materializing it (the OPFS VFS checkpoints the database, then
   * hands back a lazy stream over the file). Absent or null → callers use
   * serialize()/snapshot() and hold the whole image.
   */
  snapshotStream?(): Promise<SnapshotStreamSource | null>;
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

/**
 * Canonical placeholder-chunk ladder for dynamic IN-list statements. The
 * appliers build `IN (${placeholders})` SQL with one prepared-statement
 * cache key per distinct list length — at subtree-op scale that is one key
 * per subtree size, and past the adapter's statement-cache cap the map
 * clear/rebuild cycles. Padding every chunk up to the smallest ladder rung
 * bounds each statement template to at most `IN_CHUNK_LADDER.length`
 * distinct shapes, keeping the cache hot. The pad value "" is never a
 * stored id, so IN-membership semantics are unchanged; chunks never exceed
 * the ladder max, staying under conservative SQLite host-variable limits
 * on every backend (the stock sql.js build caps at 999).
 */
export const IN_CHUNK_LADDER = [4, 16, 64, 256, 900] as const;
export const IN_CHUNK_MAX = 900;

/**
 * Split ids into padded canonical chunks (see IN_CHUNK_LADDER). Empty input
 * yields no chunks — callers simply skip the loop, which also hardens the
 * previously malformed `IN ()` shape some sites built for empty lists.
 */
export function inListChunks(ids: readonly string[]): string[][] {
  if (ids.length === 0) return [];
  const size = IN_CHUNK_LADDER.find((rung) => ids.length <= rung) ?? IN_CHUNK_MAX;
  const chunks: string[][] = [];
  for (let start = 0; start < ids.length; start += size) {
    const chunk = ids.slice(start, start + size).slice();
    while (chunk.length < size) chunk.push("");
    chunks.push(chunk);
  }
  return chunks;
}
