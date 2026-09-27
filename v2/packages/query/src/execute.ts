/**
 * Execution helpers over a derived store (packages/store). Deliberately
 * structural — the query package stays standalone (no @notees/store
 * dependency, no import cycle with @notees/protocol); any store whose
 * `database` handle satisfies the minimal statement surface below works,
 * which the real Store does structurally.
 */

import type { QueryAst } from "./ast.js";
import { compile, compileAggregate, type CompileOptions } from "./compiler.js";

/** The slice of the store's SqliteDB surface the executor needs. */
export interface QueryStoreDatabase {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
}

export interface QueryStore {
  readonly database: QueryStoreDatabase;
}

export interface QueryResult {
  /** Deterministic order (see compiler ORDER BY): node ids. */
  ids: string[];
  /** Full node rows (`n.*`, plus `distance` for subtree/linkedTo scopes). */
  rows: Record<string, unknown>[];
}

export function runQuery(
  store: QueryStore,
  ast: QueryAst,
  options: CompileOptions = {},
): QueryResult {
  if (ast.aggregation !== undefined) {
    throw new Error(
      "query run: AST carries an aggregation — execute it with runAggregate instead",
    );
  }
  const { sql, params } = compile(ast, options);
  const rows = store.database.prepare(sql).all(...params) as Record<string, unknown>[];
  return { ids: rows.map((row) => String(row.id)), rows };
}

/**
 * Aggregation execution: the grouped grid. `columns` is the compiler's
 * deterministic column order (dimensions then measures); each row is one
 * group, aligned with `columns`.
 */
export interface AggregateResult {
  columns: string[];
  rows: unknown[][];
}

export function runAggregate(
  store: QueryStore,
  ast: QueryAst,
  options: CompileOptions = {},
): AggregateResult {
  const { sql, params, columns } = compileAggregate(ast, options);
  const raw = store.database.prepare(sql).all(...params) as Record<string, unknown>[];
  return { columns, rows: raw.map((row) => columns.map((column) => row[column])) };
}

/** Number of nodes matching the query (COUNT over the compiled select). */
export function countQuery(
  store: QueryStore,
  ast: QueryAst,
  options: CompileOptions = {},
): number {
  const { sql, params } = compile(ast, options);
  const row = store.database
    .prepare(`SELECT COUNT(*) AS count FROM (${sql})`)
    .get(...params) as { count: number };
  return Number(row.count);
}

/** Convenience: does this one node match the query? */
export function matches(
  store: QueryStore,
  nodeId: string,
  ast: QueryAst,
  options: CompileOptions = {},
): boolean {
  const { sql, params } = compile(ast, options);
  return (
    store.database.prepare(`SELECT 1 FROM (${sql}) q WHERE q.id = ?`).get(...params, nodeId) !==
    undefined
  );
}
