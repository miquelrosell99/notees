/**
 * QueryPivot — the query results' pivot view: the shared PivotGrid shell
 * over the FULL query result rows (QueryRunSummary satisfies the engine's
 * minimal PivotRow — id + the two render-state bits — so the rows pass
 * straight through). The pivot is a registry view mode now (PivotView);
 * this module is the query-results boundary that maps nothing and renders
 * the shared shell, keeping queryResults' pivot branch identical.
 */

import { PivotGrid } from "../features/collection/pivot/PivotGrid.js";
import type { AnyClient } from "../features/collection/index.js";
import type { QueryRunSummary } from "@/core/workspace-client/index.js";

export interface QueryPivotProps {
  client: AnyClient;
  /** The FULL query result rows (the pivot groups everything, not the window). */
  rows: QueryRunSummary[];
}

export function QueryPivot({ client, rows }: QueryPivotProps) {
  return <PivotGrid client={client} rows={rows} />;
}
