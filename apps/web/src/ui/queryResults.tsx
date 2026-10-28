/**
 * QueryResults — the shared query-result body: the live coalesced run
 * (useQueryRun — re-runs when the AST or the store version changes) rendered
 * in one of two shapes:
 *
 *  - list/outline or table mode: a NodeCollection over the result rows —
 *    the references-section idiom (display name + render-state chip), the
 *    query result owning ITS pagination (QUERY_RESULT_CAP rows + a load-more
 *    button past the cap, so the collection must not window again);
 *  - an AST carrying an `aggregation` always renders the aggregate grid
 *    (dimension columns + measure columns, numeric alignment) — measures
 *    need columns a list cannot carry.
 *
 * Invalid ASTs (fail-loud parse or compilation) render an "invalid query"
 * placeholder instead of crashing. Shared by the query node's block section
 * and the Queries hub — one results surface, not one per host.
 */

import { useState } from "react";

import { titleOfNode } from "./dateDisplay.js";
import {
  QUERY_TABLE_COLUMNS,
  openQueryResult,
  parseRunAst,
  queryResultItems,
  type QueryRunState,
} from "./queryRun.js";
import { NodeCollection } from "../features/collection/index.js";
import type { AnyClient, ViewMode } from "../features/collection/index.js";
import { QueryPivot } from "./QueryPivot.js";

/** Result list cap: a per-render window, not a hard ceiling — "Load more" widens it. */
export const QUERY_RESULT_CAP = 200;

/**
 * Aggregate column labels: the compiler's names are deterministic (`isClass`,
 * `isEmbedded`, `class:<id>`, `property:<id>`, `count`, `countDistinct`,
 * `<fn>:<id>`) but bare ids are unreadable — resolve class/property names
 * from the client's class facts, falling back to a short id prefix. Unknown
 * shapes stay raw.
 */
export function aggregateColumnLabel(
  column: string,
  classNames: ReadonlyMap<string, string>,
  propertyNames: ReadonlyMap<string, string>,
): string {
  if (column === "isClass") return "Class";
  if (column === "isEmbedded") return "Present as main";
  if (column === "count") return "Count";
  if (column === "countDistinct") return "Count distinct";
  const match = /^(class|property|sum|avg|min|max):(.+)$/.exec(column);
  if (match === null || match[1] === undefined || match[2] === undefined) return column;
  const [, kind, id] = match;
  if (kind === "class") {
    return classNames.get(id) ?? `Class ${id.slice(0, 8)}`;
  }
  const base = propertyNames.get(id) ?? id.slice(0, 8);
  return kind === "property" ? base : `${kind}(${base})`;
}

/** Grid cell rendering: null/undefined read as a dash, objects as JSON. */
export function formatAggregateCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * True when the AST parses and specifies NOTHING: the entire-workspace
 * scope, a bare AND group with zero conditions, no aggregation (an empty query means the user has not yet said what
 * they are looking for, so it renders the empty state instead of loading
 * the whole graph). A scope-only AST (this page / pages) is a deliberate
 * choice and still runs; an unparseable AST is not unspecified (the
 * invalid-query placeholder names it).
 */
export function isUnspecifiedQueryAst(raw: unknown): boolean {
  const parsed = parseRunAst(raw);
  if (parsed === null) return false;
  if (parsed.aggregation !== undefined) return false;
  if (parsed.scope.type !== "entire_workspace") return false;
  return parsed.root.type === "group" && parsed.root.children.length === 0;
}

export interface QueryResultsBodyProps {
  /** The full client (both classes satisfy the run seam structurally). */
  client: AnyClient;
  /** The selected tab's serialized QueryAST (the window-reset key). */
  ast: unknown;
  /** The live run — owned by the wrapper hook or the host section (export/count). */
  run: { result: QueryRunState | null; error: string | null };
  /** Unspecified query (isUnspecifiedQueryAst): render the empty state, never the run. */
  unspecified?: boolean | undefined;
  /** The transient view mode — list (outline), table, or the pivot grid (a registry mode). */
  viewMode: ViewMode;
  /** Render-cascade navigation (App routes the id). */
  onOpenNode: (nodeId: string) => void;
  onOpenInSidebar?: ((nodeId: string) => void) | undefined;
}

/** The result body over an ALREADY-RUNNING query (the host owns the run). */
export function QueryResultsBody({ client, ast, run, unspecified = false, viewMode, onOpenNode, onOpenInSidebar }: QueryResultsBodyProps) {
  const { result, error } = run;
  const [limit, setLimit] = useState(QUERY_RESULT_CAP);
  const [limitKey, setLimitKey] = useState(JSON.stringify(ast ?? null));
  // The render window resets when the query itself changes (a different
  // query starts back at the default window).
  const astKey = JSON.stringify(ast ?? null);
  if (limitKey !== astKey) {
    setLimitKey(astKey);
    setLimit(QUERY_RESULT_CAP);
  }

  if (unspecified) {
    // The empty match-all is NOT "everything": the
    // user has not yet said what they are looking for.
    return <div className="nt-query-empty">Set a query to see results.</div>;
  }
  if (error !== null) {
    return (
      <div className="nt-query-invalid" title={error}>
        invalid query
      </div>
    );
  }
  if (result === null) return null;
  if (result.rows.length === 0) return <div className="nt-query-empty">No results.</div>;
  if (viewMode === "pivot" && result.kind === "query") {
    // The pivot is a VIEW (a registry mode — PivotView renders the same
    // shell over collection items): group the full result set by the two
    // picked dimensions — a stored-question aggregation AST
    // (result.kind === "aggregate") renders its own grid below, unchanged.
    return <QueryPivot client={client} rows={result.rows} />;
  }
  if (result.kind === "aggregate") {
    const classes = client.listClasses();
    const classNames = new Map(classes.map((cls) => [cls.id, titleOfNode(cls) || cls.id]));
    const propertyNames = new Map(client.listPropertySchemas().map((schema) => [schema.id, schema.name]));
    return (
      <table className="nt-query-table">
        <thead>
          <tr>
            {result.columns.map((column, index) => (
              <th
                key={`${column}:${index}`}
                className={index >= result.dimensionCount ? "nt-query-num" : undefined}
              >
                {aggregateColumnLabel(column, classNames, propertyNames)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((cells, rowIndex) => (
            <tr key={rowIndex}>
              {cells.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className={cellIndex >= result.dimensionCount ? "nt-query-num" : undefined}
                >
                  {formatAggregateCell(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <>
      <NodeCollection
        viewMode={
          viewMode === "table"
            ? "table"
            : viewMode === "gantt"
              ? "gantt"
              : viewMode === "calendar"
                ? "calendar"
                : "outline"
        }
        client={client}
        // The query result owns ITS pagination — the 200-row window
        // (QUERY_RESULT_CAP) + the load-more below — so the collection view
        // must not window again (double-windowing would cut the cap to 100).
        windowed={false}
        items={queryResultItems(client, result.rows, limit)}
        tableColumns={QUERY_TABLE_COLUMNS}
        onNodeClick={(id) => {
          const row = result.rows.find((entry) => entry.id === id);
          if (row !== undefined) openQueryResult(client, row, onOpenNode);
        }}
        onNodeShiftClick={onOpenInSidebar}
      />
      {viewMode !== "table" && result.ids.length > limit && (
        <button
          type="button"
          className="nt-query-more"
          onClick={() => setLimit((value) => value + QUERY_RESULT_CAP)}
        >
          {result.ids.length - limit} more — load more
        </button>
      )}
    </>
  );
}
