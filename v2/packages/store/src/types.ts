/**
 * Shared better-sqlite3 statement surface. `verbatimModuleSyntax`-friendly
 * structural type so the helper modules do not depend on the Database class
 * directly (keeps unit testing and typing simple).
 */

export interface StoreDatabase {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  };
  exec(sql: string): unknown;
  pragma(source: string, options?: { simple?: boolean }): unknown;
}
