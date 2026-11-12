/**
 * GanttView — the gantt collection view mode: items as bars on a shared
 * time axis, positioned by a picked start date property, ranged by an
 * optional end date property (absent = a point-in-time bar), with an
 * Unscheduled lane for items carrying no start date. The view resolves the
 * picked properties' effective values into the model's minimal rows (the
 * same effective read the table/pivot use), computes the chart through the
 * pure ganttModel, and renders bars as plain divs — no chart library.
 *
 * Read-only surface: a bar click opens the node, shift+click peeks in the
 * sidebar (the table's navigation ruling). The property picks ride view-
 * local transient state, like the pivot's dimensions — nothing stored. The
 * visible window covers the data ± one month with month axis ticks; the
 * chart scrolls horizontally on overflow, and counts read the full set
 * (the shared pagination ruling — the gantt never windows rows away).
 */

import { useMemo, useState } from "react";

import { Dropdown } from "../../../components/ui/kit/Dropdown.js";
import { titleOfNode } from "../../../ui/dateDisplay.js";
import { useBuilderFacts } from "../builderFacts.js";
import { registerView } from "../registry.js";
import type { NodeCollectionProps } from "../types.js";
import {
  buildGantt,
  ganttDateOf,
  ganttMonthLabel,
  todayOrdinal,
  type GanttInputRow,
} from "./ganttModel.js";

import "./GanttView.css";

/** The bar's minimum visible share of the window (a point bar never
 *  collapses to zero width). */
const MIN_BAR_PCT = 0.8;

const NO_END = "__none__";

export function GanttView({ client, items, onNodeClick, onNodeShiftClick }: NodeCollectionProps) {
  const facts = useBuilderFacts(client);
  /** The collection's date-typed bound properties (the picker vocabulary). */
  const dateProperties = useMemo(
    () => facts.boundProperties.filter((property) => property.type === "datetime"),
    [facts],
  );

  const [startPropertyId, setStartPropertyId] = useState<string | null>(null);
  const [endPropertyId, setEndPropertyId] = useState<string>(NO_END);

  const startId = startPropertyId ?? dateProperties[0]?.id ?? null;
  const endId = endPropertyId === NO_END ? null : endPropertyId;

  /** Items → model rows: the picked properties' effective values resolve
   *  to calendar dates (bound-but-empty reads as null → the lane). */
  const rows = useMemo<GanttInputRow[]>(() => {
    if (startId === null) return [];
    return (items ?? []).map((item) => {
      const effective = client.getEffectiveProperties(item.node.id);
      const startEntry = effective.find((property) => property.propertySchemaId === startId);
      const endEntry =
        endId === null
          ? undefined
          : effective.find((property) => property.propertySchemaId === endId);
      return {
        id: item.node.id,
        name: titleOfNode(item.node) || item.node.id,
        color: item.node.color,
        start: ganttDateOf(startEntry?.value, "start"),
        end: ganttDateOf(endEntry?.value, "end"),
      };
    });
  }, [client, items, startId, endId]);

  const chart = useMemo(() => buildGantt(rows), [rows]);

  const span = chart.window === null ? 0 : chart.window.to - chart.window.from;
  const pctOf = (ordinal: number): number =>
    chart.window === null ? 0 : ((ordinal - chart.window.from) / span) * 100;
  const today = todayOrdinal();
  const todayInRange = chart.window !== null && today >= chart.window.from && today < chart.window.to;

  const open = (id: string, shiftKey: boolean) => {
    if (shiftKey) onNodeShiftClick?.(id);
    else onNodeClick?.(id);
  };

  const startOptions = dateProperties.map((property) => ({
    value: property.id,
    label: property.name,
  }));
  const endOptions = [
    { value: NO_END, label: "—" },
    ...dateProperties.filter((property) => property.id !== startId).map((property) => ({
      value: property.id,
      label: property.name,
    })),
  ];

  if (startId === null) return <div className="gantt gantt--empty">No date property available.</div>;

  return (
    <div className="gantt">
      <div className="gantt__toolbar">
        <Dropdown
          size="sm"
          ariaLabel="Start"
          options={startOptions}
          value={startId}
          onChange={(value) => {
            if (value === null) return;
            setStartPropertyId(value);
            // The end pick never duplicates the start pick.
            if (endId === value) setEndPropertyId(NO_END);
          }}
        />
        {dateProperties.length >= 2 && (
          <Dropdown
            size="sm"
            ariaLabel="End"
            options={endOptions}
            value={endId ?? NO_END}
            onChange={(value) => {
              if (value !== null) setEndPropertyId(value);
            }}
          />
        )}
      </div>
      {chart.window === null ? (
        <div className="gantt__lane gantt__lane--only">
          <div className="gantt__lane-title">Unscheduled ({chart.unscheduled.length})</div>
          {chart.unscheduled.map((row) => (
            <div key={row.id} className="gantt__row gantt__row--lane">
              <button
                type="button"
                className="gantt__name"
                onClick={(event) => open(row.id, event.shiftKey)}
              >
                {row.name}
              </button>
              <span className="gantt__lane-dash">—</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="gantt__scroll">
          <div
            className="gantt__chart"
            style={{
              "--gantt-months": chart.ticks.length,
              ...(todayInRange ? { "--gantt-today": `${pctOf(today)}%` } : {}),
              minWidth: `max(100%, ${chart.ticks.length * 9}ch)`,
            } as React.CSSProperties}
          >
            <div className="gantt__axis" aria-hidden="true">
              <span className="gantt__axis-corner" />
              <div className="gantt__axis-track">
                {chart.ticks.map((tick) => (
                  <span key={tick} className="gantt__tick" style={{ left: `${pctOf(tick)}%` }}>
                    {ganttMonthLabel(tick)}
                  </span>
                ))}
              </div>
            </div>
            {chart.bars.map((bar) => {
              const left = pctOf(bar.startOrdinal);
              const width = bar.endOrdinal === null
                ? MIN_BAR_PCT
                : Math.max(pctOf(bar.endOrdinal) - left, MIN_BAR_PCT);
              return (
                <div key={bar.id} className="gantt__row">
                  <button
                    type="button"
                    className="gantt__name"
                    onClick={(event) => open(bar.id, event.shiftKey)}
                  >
                    {bar.name}
                  </button>
                  <div className="gantt__track">
                    <button
                      type="button"
                      className="gantt__bar"
                      data-node-id={bar.id}
                      style={{
                        left: `${left}%`,
                        width: `${width}%`,
                        ...(bar.color !== null ? { backgroundColor: bar.color } : {}),
                      }}
                      aria-label={bar.name}
                      title={bar.name}
                      onClick={(event) => open(bar.id, event.shiftKey)}
                    />
                  </div>
                </div>
              );
            })}
            {chart.unscheduled.length > 0 && (
              <div className="gantt__lane">
                <div className="gantt__lane-title gantt__row">
                  <span className="gantt__name gantt__name--static">Unscheduled</span>
                  <span className="gantt__track gantt__lane-count">
                    {chart.unscheduled.length}
                  </span>
                </div>
                {chart.unscheduled.map((row) => (
                  <div key={row.id} className="gantt__row gantt__row--lane">
                    <button
                      type="button"
                      className="gantt__name"
                      onClick={(event) => open(row.id, event.shiftKey)}
                    >
                      {row.name}
                    </button>
                    <span className="gantt__track gantt__lane-dash">—</span>
                  </div>
                ))}
              </div>
            )}
          </div>        </div>
      )}
    </div>
  );
}

registerView({
  id: "gantt",
  label: "Gantt",
  icon: "mdi-chart-gantt",
  component: GanttView,
  tier: "secondary",
  // A collection offers the gantt only when a date property carries a value
  // (no date → no axis → a dead option).
  availability: (ctx) => ctx.datePropertyCount >= 1,
  capabilities: {},
});
