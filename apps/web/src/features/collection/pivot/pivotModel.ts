/**
 * pivotModel — the pure grouping/derivation engine behind BOTH pivot
 * surfaces: the query results' pivot (QueryPivot over QueryRunSummary rows)
 * and the collection registry's pivot view (PivotView over the collection's
 * items). The two hosts map their own row shapes INTO the minimal PivotRow
 * at their boundary — query-specific types never leak into the collection
 * feature.
 *
 * A 2D grid: one group-by dimension rides the ROWS axis, one rides the
 * COLUMNS axis, each cell carries a measure (count, or sum/average over a
 * number property) of the rows at that intersection — a spreadsheet pivot
 * with two group-bys instead of one. Dimension vocabulary: the class bit,
 * the structural role, class membership, and the bound properties
 * (effective values, so a defaulted property groups under its default);
 * distinct values per axis cap at 20 with an overflow "Other" bucket.
 */

import type { AnyClient } from "../types.js";
import type { BuilderFacts } from "../builderFacts.js";
import { titleOf } from "../../../ui/dateDisplay.js";

/**
 * The minimal row the engine needs — both hosts map into it:
 * QueryRunSummary (id/isClass/isEmbedded + query extras) and NodeCollection
 * items (the ClientNode carries the same three).
 */
export interface PivotRow {
  id: string;
  isClass: boolean;
  isEmbedded: boolean;
}

export type DimensionKind = "none" | "isClass" | "isEmbedded" | "class" | "property";

export interface DimensionSelection {
  kind: DimensionKind;
  /** The class/property id (class + property kinds). */
  id?: string;
}

export type Measure = { kind: "count" } | { kind: "sum" | "avg"; propertyId: string };

/** Distinct values per axis beyond this collapse into the "Other" bucket. */
export const MAX_DISTINCT = 20;
export const OTHER = "Other";
export const UNSET = "—";

/** One row's value on a dimension — the group key (already display-formatted). */
export function dimensionValue(
  client: AnyClient,
  row: PivotRow,
  dim: DimensionSelection,
  facts: BuilderFacts,
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
export function formatValue(client: AnyClient, value: unknown, facts: BuilderFacts): string {
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

/** The measure's numeric contribution of one row (null = not counted for sum/avg). */
export function measureContribution(
  client: AnyClient,
  row: PivotRow,
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

export function formatMeasure(value: number, measure: Measure): string {
  if (measure.kind === "count") return String(value);
  return String(Number(value.toFixed(2)));
}

/** Distinct values, sorted (numeric-aware), unset LAST, capped with an "Other" overflow. */
export function bucketize(values: string[]): { values: string[]; map: Map<string, string> } {
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

/** Cell-key separator: display-formatted group keys can contain any text
 *  (spaces, punctuation), so the axes join on a NUL — unambiguous and never
 *  present in a title. */
export const CELL_SEP = "\u0000";

/** The pivot grid over the FULL row set: bucketed axes + accumulated cells. */
export function computePivotGrid(
  client: AnyClient,
  rows: readonly PivotRow[],
  rowDim: DimensionSelection,
  colDim: DimensionSelection,
  measure: Measure,
  facts: BuilderFacts,
): {
  rowsAxis: { values: string[]; map: Map<string, string> };
  colsAxis: { values: string[]; map: Map<string, string> };
  cells: Map<string, { total: number; count: number }>;
} {
  const rowKeys = rows.map((row) => dimensionValue(client, row, rowDim, facts));
  const colKeys = rows.map((row) => dimensionValue(client, row, colDim, facts));
  const rowsAxis = bucketize(rowKeys);
  const colsAxis = bucketize(colKeys);
  const cells = new Map<string, { total: number; count: number }>();
  for (let i = 0; i < rows.length; i += 1) {
    const bucket = `${rowsAxis.map.get(rowKeys[i]!)!}${CELL_SEP}${colsAxis.map.get(colKeys[i]!)!}`;
    const contribution = measureContribution(client, rows[i]!, measure);
    if (contribution === null) continue;
    const cell = cells.get(bucket) ?? { total: 0, count: 0 };
    cell.total += contribution;
    cell.count += 1;
    cells.set(bucket, cell);
  }
  return { rowsAxis, colsAxis, cells };
}

/** The dimension picker vocabulary (the shared facts derivation). */
export function dimensionOptions(facts: BuilderFacts): Array<{ value: string; label: string }> {
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
}

/** The measure picker vocabulary: count + sum/average over number properties. */
export function measureOptions(facts: BuilderFacts): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = [{ value: "count", label: "Count" }];
  for (const property of facts.numericProperties) {
    options.push({ value: `sum:${property.id}`, label: `Sum of ${property.name}` });
    options.push({ value: `avg:${property.id}`, label: `Average of ${property.name}` });
  }
  return options;
}

export function encodeDim(dim: DimensionSelection): string {
  return dim.kind === "none"
    ? "none"
    : dim.kind === "isClass"
      ? "isClass"
      : dim.kind === "isEmbedded"
        ? "isEmbedded"
        : `${dim.kind}:${dim.id ?? ""}`;
}

export function decodeDim(value: string): DimensionSelection {
  if (value === "none" || value === "isClass" || value === "isEmbedded") return { kind: value };
  const [kind, ...rest] = value.split(":");
  return { kind: kind as "class" | "property", id: rest.join(":") };
}

export function encodeMeasure(measure: Measure): string {
  return measure.kind === "count" ? "count" : `${measure.kind}:${measure.propertyId}`;
}

export function decodeMeasure(value: string): Measure {
  if (value === "count") return { kind: "count" };
  const [kind, ...rest] = value.split(":");
  return { kind: kind as "sum" | "avg", propertyId: rest.join(":") };
}

/** The corner label naming the columns dimension (empty for the none kind). */
export function dimLabel(dim: DimensionSelection, facts: BuilderFacts): string {
  if (dim.kind === "class") return `Member of ${facts.classNames.get(dim.id ?? "") ?? "class"}`;
  if (dim.kind === "property") return facts.propertyNames.get(dim.id ?? "") ?? "Property";
  return "";
}
