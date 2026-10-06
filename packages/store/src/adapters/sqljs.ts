/**
 * sql.js adapter (browser/WASM target): synchronous in-memory SQLite over
 * the sql.js WASM build.
 *
 *  - run/get/all map onto db.run / db.exec (sql.js has no prepared-statement
 *    objects; statements are re-executed per call);
 *  - transaction() wraps fn in a SAVEPOINT (sql.js is synchronous, so the
 *    simple savepoint wrapper gives better-sqlite3's transaction semantics);
 *  - serialize() is db.export(); restore loads the bytes into a fresh
 *    in-memory database;
 *  - the stock sql.js build ships without FTS5, so this backend declares
 *    ftsModule "fts4" (see schemaSql).
 *
 * sql.js surfaces SQLite errors as plain Errors without a `code` property;
 * this adapter tags them with SQLITE_ERROR so the store's error translation
 * (isSqliteError / translateSqliteError) keeps working.
 */

import type { Database, SqlJsStatic, SqlValue } from "sql.js";

import type { SqliteDB, SqliteStatement, StoreBackend } from "../db.js";

/**
 * sql.js surfaces SQLite errors as plain Errors without a `code` property;
 * this adapter tags them with SQLITE_ERROR so the store's error translation
 * (isSqliteError / translateSqliteError) keeps working.
 *
 * sql.js ALSO throws bare values at the API boundary — notably the frozen
 * STRING "Database closed" after close() — which carry no stack and fail
 * every `error instanceof Error` check downstream (they would surface as
 * stack-less unhandled rejections from any fire-and-forget caller). Wrap any
 * non-Error throw in a real Error with the same message: the translation
 * path is unchanged (no code is attached), but the failure is diagnosable.
 */
function tagSqliteError(error: unknown): never {
  if (typeof error !== "string" && !(error instanceof Error)) {
    throw new Error(String(error));
  }
  if (error instanceof Error && !("code" in error)) {
    try {
      (error as { code?: string }).code = "SQLITE_ERROR";
    } catch {
      // Non-extensible error object: leave it untagged.
    }
  }
  throw error;
}

function bindParams(params: unknown[]): SqlValue[] {
  // sql.js rejects undefined bindings; the store never sends them, but map
  // defensively (SQLite semantics: unbound -> NULL).
  return params.map((p) => (p === undefined ? null : (p as SqlValue)));
}

interface QueryResult {
  columns: string[];
  values: SqlValue[][];
}

function toRows(result: QueryResult | undefined): Record<string, SqlValue>[] {
  if (!result) return [];
  return result.values.map((values) =>
    Object.fromEntries(result.columns.map((column, i) => [column, values[i]!])),
  );
}

class SqlJsStatement implements SqliteStatement {
  constructor(
    private readonly db: Database,
    private readonly sql: string,
  ) {}

  run(...params: unknown[]): { changes: number } {
    try {
      this.db.run(this.sql, bindParams(params));
      return { changes: this.db.getRowsModified() };
    } catch (error) {
      tagSqliteError(error);
    }
  }

  get(...params: unknown[]): unknown {
    try {
      return toRows(this.db.exec(this.sql, bindParams(params))[0])[0];
    } catch (error) {
      tagSqliteError(error);
    }
  }

  all(...params: unknown[]): unknown[] {
    try {
      return toRows(this.db.exec(this.sql, bindParams(params))[0]);
    } catch (error) {
      tagSqliteError(error);
    }
  }
}

export class SqlJsDB implements SqliteDB {
  constructor(readonly raw: Database) {}

  exec(sql: string): void {
    try {
      this.raw.exec(sql);
    } catch (error) {
      tagSqliteError(error);
    }
  }

  prepare(sql: string): SqliteStatement {
    return new SqlJsStatement(this.raw, sql);
  }

  pragma(source: string, options?: { simple?: boolean }): unknown {
    try {
      const results = this.raw.exec(`PRAGMA ${source}`);
      if (options?.simple) return results[0]?.values[0]?.[0];
      return results;
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
    return this.raw.export();
  }

  close(): void {
    this.raw.close();
  }
}

/** StoreBackend over a fresh sql.js in-memory database per connection. */
export function sqljsBackend(SQL: SqlJsStatic): StoreBackend {
  const open = (): SqlJsDB => new SqlJsDB(new SQL.Database());
  return {
    ftsModule: "fts4",
    open,
    restore: (bytes) => new SqlJsDB(new SQL.Database(bytes)),
    reset: open,
  };
}
