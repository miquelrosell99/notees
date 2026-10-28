/**
 * QueryPivot — the query results' transient PIVOT view mode (a pivot is a VIEW, not a query — the query selects the row
 * set, the view decides how to look at it). A 2D grid: one group-by
 * dimension rides the ROWS axis, one rides the COLUMNS axis, and each cell
 * carries a measure (count, or a sum/average over a number property) of the
 * nodes at that intersection — a spreadsheet pivot with two group-bys
 * instead of one.
 *
 * Everything is TRANSIENT: the mode, both dimension picks, and the measure
 * are component state (like the list/table switch) — reload resets to the
 * list. Nothing is stored, matching the group-by ruling (view modes never
 * persist; a query node stores its question, not its lens). The stored-
 * question aggregation in the AST (the legacy grid) is a different animal
 * and renders unchanged.
 *
 * The pivot groups the FULL result set client-side (not the 200-row render
 * window — the window is a list-rendering concern) and re-derives on the
 * client's notify cycle. Dimension vocabulary: the class bit, the
 * structural role, class membership, and the bound properties (effective
 * values, so a defaulted property groups under its default); distinct
 * values per axis cap at 20 with an overflow "Other" bucket.
 */

import { useMemo, useState } from "react";

import type { AnyClient, ViewMode } from "../features/collection/index.js";
import { useBuilderFacts } from "../features/collection/builderFacts.js";
import { Dropdown } from "../components/ui/kit/Dropdown.js";
import { titleOf } from "./dateDisplay.js";
import "./QueryPivot.css";
import type { QueryRunSummary } from "@/core/workspace-client/index.js";

/** The query results' view modes — the transient list (outline), table, and pivot. */
export type QueryViewMode = Extract<ViewMode, "outline" | "table"> | "pivot";

type DimensionKind = "none" | "isClass" | "isEmbedded" | "class" | "property";

interface DimensionSelection {
  kind: DimensionKind;
  /** The class/property id (class + property kinds). */
  id?: string;
}

type Measure = { kind: "count" } | { kind: "sum" | "avg"; propertyId: string };

/** Distinct values per axis beyond this collapse into the "Other" bucket. */
const MAX_DISTINCT = 20;
const OTHER = "Other";
const UNSET = "—";

interface QueryPivotProps {
  client: AnyClient;
  /** The FULL query result rows (the pivot groups everything, not the window). */
  rows: QueryRunSummary[];
}

/** One node's value on a dimension — the group key (already display-formatted). */
function dimensionValue(
  client: AnyClient,
  row: QueryRunSummary,
  dim: DimensionSelection,
  facts: ReturnType<typeof useBuilderFacts>,
): string {
  switch (dim.kind) {
    case "none":
      return "";
    case "isClass":
      return row.isClass ? "Class" : "Not a class";
    case "isEmbedded":
      return row.isEmbedded ? "Block" : "Page";
    case "class":
      return client.getNode(row.id)?.classIds.includes(dim.id ?? "") === true ? "Yes" : "No";
    case "property": {
      const effective = client.getEffectiveProperties(row.id);
      const entry = effective.find((property) => property.propertySchemaId === dim.id);
      if (entry === undefined || entry.value === null || entry.value === undefined) return UNSET;
      return formatValue(client, entry.value, facts);
    }
  }
}

/** A property value → its display-formatted group key (multi-value joins). */
function formatValue(client: AnyClient, value: unknown, facts: ReturnType<typeof useBuilderFacts>): string {
  const one = (single: unknown): string => {
    if (single === null || single === undefined) return UNSET;
    if (typeof single === "boolean") return single ? "Yes" : "No";
    if (typeof single === "number" || typeof single === "string") return String(single);
    if (typeof single === "object") {
      const ref = single as { nodeId?: unknown; targetNodeId?: unknown; id?: unknown; label?: unknown };
      const nodeId = typeof ref.nodeId === "string" ? ref.nodeId : typeof ref.targetNodeId === "string" ? ref.targetNodeId : null;
      if (nodeId !== null) return titleOf(client, nodeId) ?? nodeId;
      if (typeof ref.label === "string") return ref.label;
      if (typeof ref.id === "string") {
        // An option id — resolve through the bound-property options.
        for (const property of facts.boundProperties) {
          const option = property.options?.find((candidate) => candidate.id === ref.id);
          if (option !== undefined) return option.label;
        }
        return ref.id;
      }
      return JSON.stringify(single);
    }
    return String(single);
  };
  if (Array.isArray(value)) {
    const parts = value.map(one).filter((part) => part !== UNSET);
    return parts.length === 0 ? UNSET : parts.join(", ");
  }
  return one(value);
}

/** The measure's numeric contribution of one node (null = not counted for sum/avg). */
function measureContribution(
  client: AnyClient,
  row: QueryRunSummary,
  measure: Measure,
): number | null {
  if (measure.kind === "count") return 1;
  const effective = client.getEffectiveProperties(row.id);
  const entry = effective.find((property) => property.propertySchemaId === measure.propertyId);
  if (entry === undefined) return null;
  const values = Array.isArray(entry.value) ? entry.value : [entry.value];
  let total = 0;
  let seen = 0;
  for (const value of values) {
    if (typeof value === "number") {
      total += value;
      seen += 1;
    }
  }
  if (seen === 0) return null;
  return measure.kind === "sum" ? total : total / seen;
}

function formatMeasure(value: number, measure: Measure): string {
  if (measure.kind === "count") return String(value);
  return String(Number(value.toFixed(2)));
}

/** Distinct values, sorted (numeric-aware), unset LAST, capped with an "Other" overflow. */
function bucketize(values: string[]): { values: string[]; map: Map<string, string> } {
  const distinct = [...new Set(values)];
  distinct.sort((a, b) => {
    if (a === UNSET) return 1;
    if (b === UNSET) return -1;
    const numA = Number(a);
    const numB = Number(b);
    if (!Number.isNaN(numA) && !Number.isNaN(numB)) return numA - numB;
    return a.localeCompare(b);
  });
  const kept = distinct.slice(0, MAX_DISTINCT);
  const map = new Map<string, string>();
  for (const value of distinct) {
    map.set(value, kept.includes(value) ? value : OTHER);
  }
  return { values: distinct.length > MAX_DISTINCT ? [...kept, OTHER] : kept, map };
}

export function QueryPivot({ client, rows }: QueryPivotProps) {
  const facts = useBuilderFacts(client);
  const [rowDim, setRowDim] = useState<DimensionSelection>({ kind: "none" });
  const [colDim, setColDim] = useState<DimensionSelection>({ kind: "none" });
  const [measure, setMeasure] = useState<Measure>({ kind: "count" });

  const dimensionOptions = useMemo(() => {
    const options: Array<{ value: string; label: string }> = [
      { value: "none", label: "None" },
      { value: "isClass", label: "Class bit" },
      { value: "isEmbedded", label: "Structural role" },
    ];
    for (const cls of facts.classes) {
      options.push({ value: `class:${cls.id}`, label: `Member of ${facts.classNames.get(cls.id) ?? cls.id}` });
    }
    for (const property of facts.boundProperties) {
      options.push({ value: `property:${property.id}`, label: `Property: ${property.name}` });
    }
    return options;
  }, [facts]);

  const measureOptions = useMemo(() => {
    const options: Array<{ value: string; label: string }> = [{ value: "count", label: "Count" }];
    for (const property of facts.numericProperties) {
      options.push({ value: `sum:${property.id}`, label: `Sum of ${property.name}` });
      options.push({ value: `avg:${property.id}`, label: `Average of ${property.name}` });
    }
    return options;
  }, [facts]);

  const encodeDim = (dim: DimensionSelection): string =>
    dim.kind === "none" ? "none" : dim.kind === "isClass" ? "isClass" : dim.kind === "isEmbedded" ? "isEmbedded" : `${dim.kind}:${dim.id ?? ""}`;
  const decodeDim = (value: string): DimensionSelection => {
    if (value === "none" || value === "isClass" || value === "isEmbedded") return { kind: value };
    const [kind, ...rest] = value.split(":");
    return { kind: kind as "class" | "property", id: rest.join(":") };
  };
  const encodeMeasure = (m: Measure): string => (m.kind === "count" ? "count" : `${m.kind}:${m.propertyId}`);
  const decodeMeasure = (value: string): Measure => {
    if (value === "count") return { kind: "count" };
    const [kind, ...rest] = value.split(":");
    return { kind: kind as "sum" | "avg", propertyId: rest.join(":") };
  };

  const grid = useMemo(() => {
    const rowKeys = rows.map((row) => dimensionValue(client, row, rowDim, facts));
    const colKeys = rows.map((row) => dimensionValue(client, row, colDim, facts));
    const rowsAxis = bucketize(rowKeys);
    const colsAxis = bucketize(colKeys);
    const cells = new Map<string, { total: number; count: number }>();
    for (let i = 0; i < rows.length; i += 1) {
      const bucket = `${rowsAxis.map.get(rowKeys[i]!)!} ${colsAxis.map.get(colKeys[i]!)!}`;
      const contribution = measureContribution(client, rows[i]!, measure);
      if (contribution === null) continue;
      const cell = cells.get(bucket) ?? { total: 0, count: 0 };
      cell.total += contribution;
      cell.count += 1;
      cells.set(bucket, cell);
    }
    return { rowsAxis, colsAxis, cells };
  }, [client, rows, rowDim, colDim, measure, facts]);

  const dimLabel = (dim: DimensionSelection): string => {
    if (dim.kind === "class") return `Member of ${facts.classNames.get(dim.id ?? "") ?? "class"}`;
    if (dim.kind === "property") return facts.propertyNames.get(dim.id ?? "") ?? "Property";
    return "";
  };

  const cellValue = (rowKey: string, colKey: string): string => {
    const cell = grid.cells.get(`${rowKey} ${colKey}`);
    if (cell === undefined) return "—";
    const value = measure.kind === "avg" ? (cell.count > 0 ? cell.total / cell.count : 0) : cell.total;
    return formatMeasure(value, measure);
  };

  return (
    <div className="nt-query-pivot">
      <div className="nt-query-pivot__controls">
        <Dropdown
          size="sm"
          ariaLabel="Rows"
          options={dimensionOptions}
          value={encodeDim(rowDim)}
          onChange={(value) => {
            if (value !== null) setRowDim(decodeDim(value));
          }}
        />
        <Dropdown
          size="sm"
          ariaLabel="Columns"
          options={dimensionOptions}
          value={encodeDim(colDim)}
          onChange={(value) => {
            if (value !== null) setColDim(decodeDim(value));
          }}
        />
        <Dropdown
          size="sm"
          ariaLabel="Measure"
          options={measureOptions}
          value={encodeMeasure(measure)}
          onChange={(value) => {
            if (value !== null) setMeasure(decodeMeasure(value));
          }}
        />
      </div>
      {grid.rowsAxis.values.length === 0 || grid.colsAxis.values.length === 0 ? (
        <div className="nt-query-empty">No results.</div>
      ) : (
        <table className="nt-query-pivot__grid">
          <thead>
            <tr>
              <th className="nt-query-pivot__corner">{dimLabel(colDim)}</th>
              {grid.colsAxis.values.map((col) => (
                <th key={col}>{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rowsAxis.values.map((rowKey) => (
              <tr key={rowKey}>
                <th scope="row">{rowKey === "" ? "All" : rowKey}</th>
                {grid.colsAxis.values.map((col) => (
                  <td key={col} className="nt-query-num">
                    {cellValue(rowKey, col)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
