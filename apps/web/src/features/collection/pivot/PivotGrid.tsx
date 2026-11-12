/**
 * PivotGrid — the shared pivot shell: the dimension/measure pickers (kit
 * Dropdowns) over the 2D grid table. Consumed by BOTH pivot hosts:
 * QueryPivot (the query results' view over QueryRunSummary rows) and
 * PivotView (the collection registry's pivot mode over NodeCollection
 * items) — both map into the engine's minimal PivotRow and render this
 * shell verbatim. Everything is transient component state: the mode, both
 * dimension picks, and the measure (display state, never an op).
 */

import { useMemo, useState } from "react";

import { Dropdown } from "../../../components/ui/kit/Dropdown.js";
import { useBuilderFacts } from "../builderFacts.js";
import type { AnyClient } from "../types.js";
import {
  computePivotGrid,
  decodeDim,
  decodeMeasure,
  dimLabel,
  dimensionOptions,
  encodeDim,
  encodeMeasure,
  formatMeasure,
  measureOptions,
  CELL_SEP,
  type DimensionSelection,
  type Measure,
  type PivotRow,
} from "./pivotModel.js";

import "./PivotGrid.css";

export interface PivotGridProps {
  client: AnyClient;
  /** The FULL row set (the pivot groups everything, not a render window). */
  rows: PivotRow[];
}

export function PivotGrid({ client, rows }: PivotGridProps) {
  const facts = useBuilderFacts(client);
  const [rowDim, setRowDim] = useState<DimensionSelection>({ kind: "none" });
  const [colDim, setColDim] = useState<DimensionSelection>({ kind: "none" });
  const [measure, setMeasure] = useState<Measure>({ kind: "count" });

  const dims = useMemo(() => dimensionOptions(facts), [facts]);
  const measures = useMemo(() => measureOptions(facts), [facts]);

  const grid = useMemo(
    () => computePivotGrid(client, rows, rowDim, colDim, measure, facts),
    [client, rows, rowDim, colDim, measure, facts],
  );

  const cellValue = (rowKey: string, colKey: string): string => {
    const cell = grid.cells.get(`${rowKey}${CELL_SEP}${colKey}`);
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
          options={dims}
          value={encodeDim(rowDim)}
          onChange={(value) => {
            if (value !== null) setRowDim(decodeDim(value));
          }}
        />
        <Dropdown
          size="sm"
          ariaLabel="Columns"
          options={dims}
          value={encodeDim(colDim)}
          onChange={(value) => {
            if (value !== null) setColDim(decodeDim(value));
          }}
        />
        <Dropdown
          size="sm"
          ariaLabel="Measure"
          options={measures}
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
              <th className="nt-query-pivot__corner">{dimLabel(colDim, facts)}</th>
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
