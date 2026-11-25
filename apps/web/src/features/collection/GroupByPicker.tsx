/**
 * GroupByPicker — the collection chrome's "Group by" dropdown (the generic
 * group-by, 2026-11-25): the pseudo-axes (page / parent / tag / class /
 * created / edited) plus every groupable (non-text) property the item set
 * carries, with a SEARCH BOX filtering the list by name. Date-typed axes
 * (datetime properties, created, edited) carry a ZOOM SUBMENU — year /
 * month / week / day — expanded from the axis row; picking the axis without
 * a zoom keeps the axis's current zoom (or the month default). The choice
 * is the host's (CollectionHub persists it device-locally per surface —
 * never an op).
 */

import { useMemo, useState } from "react";

import { ButtonWithPanel, Input } from "../../components/ui/kit/index.js";
import { Icon } from "../../ui/Icon.js";
import {
  DATE_ZOOMS,
  DEFAULT_DATE_ZOOM,
  groupByAxes,
  groupBySpecLabel,
  type DateZoom,
  type GroupByAxis,
  type GroupBySpec,
} from "./grouping.js";
import type { AnyClient, NodeCollectionItem } from "./types.js";
import "./GroupByPicker.css";

const ZOOM_LABELS: Record<DateZoom, string> = {
  year: "Year",
  month: "Month",
  week: "Week",
  day: "Day",
};

/** The axis identity WITHOUT the zoom (the zoom rides the same axis). */
function axisKeyOf(spec: GroupBySpec): string {
  return spec.kind === "property" ? `property:${spec.schemaId}` : spec.kind;
}

export function GroupByPicker({
  client,
  items,
  value,
  onChange,
}: {
  client: AnyClient;
  items: NodeCollectionItem[];
  value: GroupBySpec | null;
  onChange: (spec: GroupBySpec | null) => void;
}) {
  const [query, setQuery] = useState("");
  /** The date axis whose zoom submenu is expanded (axis key, null = none). */
  const [zoomOpenKey, setZoomOpenKey] = useState<string | null>(null);
  const axes = useMemo(() => groupByAxes(client, items), [client, items]);
  const activeAxisKey = value !== null ? axisKeyOf(value) : null;
  const needle = query.trim().toLowerCase();
  const filtered =
    needle === "" ? axes : axes.filter((axis) => axis.label.toLowerCase().includes(needle));

  const pick = (axis: GroupByAxis, zoom: DateZoom | undefined, close: () => void): void => {
    if (!axis.date) {
      onChange(axis.spec);
    } else {
      const kept =
        zoom ??
        (value !== null && axisKeyOf(value) === axisKeyOf(axis.spec) && "zoom" in value
          ? (value.zoom ?? DEFAULT_DATE_ZOOM)
          : DEFAULT_DATE_ZOOM);
      onChange(
        axis.spec.kind === "property"
          ? { kind: "property", schemaId: axis.spec.schemaId, zoom: kept }
          : axis.spec.kind === "created"
            ? { kind: "created", zoom: kept }
            : { kind: "edited", zoom: kept },
      );
    }
    close();
  };

  const activeZoom: DateZoom =
    value !== null && "zoom" in value ? (value.zoom ?? DEFAULT_DATE_ZOOM) : DEFAULT_DATE_ZOOM;
  const triggerLabel =
    value === null
      ? "Group"
      : `${groupBySpecLabel(client, value)}${
          value.kind === "created" || value.kind === "edited" || "zoom" in value
            ? ` · ${ZOOM_LABELS["zoom" in value ? (value.zoom ?? DEFAULT_DATE_ZOOM) : DEFAULT_DATE_ZOOM]}`
            : ""
        }`;

  return (
    <ButtonWithPanel
      icon="mdi-group"
      buttonText={triggerLabel}
      variant="ghost"
      size="sm"
      panelPosition="bottom"
      panelAlignment="end"
      tooltip="Group by"
      aria-label="Group by"
      buttonProps={{ "aria-label": "Group by" }}
      active={value !== null}
      panelClassName="groupby-panel-card"
    >
      {(closePanel) => (
        <div className="groupby-panel">
          <div className="groupby-panel__search">
            <Input
              autoFocus
              placeholder="Search properties…"
              aria-label="Search group-by properties"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="groupby-panel__list">
            <button
              type="button"
              data-menu-item
              className={`groupby-panel__item${value === null ? " groupby-panel__item--active" : ""}`}
              onClick={() => {
                onChange(null);
                closePanel();
              }}
            >
              <span className="groupby-panel__item-label">None</span>
              {value === null && <Icon path="mdi-check" size={0.8} className="groupby-panel__check" />}
            </button>
            {filtered.map((axis) => {
              const axisKey = axisKeyOf(axis.spec);
              const isActive = axisKey === activeAxisKey;
              const zoomOpen = axis.date && (zoomOpenKey === axisKey || (zoomOpenKey === null && isActive));
              return (
                <div className="groupby-panel__axis" key={axisKey}>
                  <div className="groupby-panel__axis-row">
                    <button
                      type="button"
                      data-menu-item
                      className={`groupby-panel__item${isActive ? " groupby-panel__item--active" : ""}`}
                      onClick={() => pick(axis, undefined, closePanel)}
                    >
                      <Icon path={axis.icon} size={0.9} className="groupby-panel__icon" />
                      <span className="groupby-panel__item-label">{axis.label}</span>
                      {isActive && <Icon path="mdi-check" size={0.8} className="groupby-panel__check" />}
                    </button>
                    {axis.date && (
                      <button
                        type="button"
                        className="groupby-panel__zoom-toggle"
                        aria-label={`${zoomOpen ? "Hide" : "Choose"} the ${axis.label} grouping zoom`}
                        aria-expanded={zoomOpen}
                        onClick={() => setZoomOpenKey(zoomOpen && zoomOpenKey !== null ? null : axisKey)}
                      >
                        <Icon
                          path={zoomOpen ? "mdi-chevron-down" : "mdi-chevron-right"}
                          size={0.8}
                        />
                      </button>
                    )}
                  </div>
                  {zoomOpen && (
                    <div className="groupby-panel__zoom" role="group" aria-label={`${axis.label} zoom`}>
                      {DATE_ZOOMS.map((zoom) => (
                        <button
                          key={zoom}
                          type="button"
                          data-menu-item
                          className={`groupby-panel__zoom-option${
                            isActive && activeZoom === zoom ? " groupby-panel__zoom-option--active" : ""
                          }`}
                          onClick={() => pick(axis, zoom, closePanel)}
                        >
                          {ZOOM_LABELS[zoom]}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {filtered.length === 0 && (
              <div className="groupby-panel__empty">No matching properties.</div>
            )}
          </div>
        </div>
      )}
    </ButtonWithPanel>
  );
}
