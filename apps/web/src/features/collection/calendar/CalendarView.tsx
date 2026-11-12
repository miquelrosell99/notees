/**
 * CalendarView — the calendar collection view mode: the collection's items
 * placed on a month grid by a picked date property, with an agenda strip
 * for the selected day. The complement to the gantt (gantt is duration,
 * calendar is point-in-time): items with no date value stay OFF the grid —
 * a point in time IS the calendar's unit; the Unscheduled lane is the
 * gantt's concern.
 *
 * One page per month — a collection lens, not the journal's infinite feed.
 * The grid reuses the calendar surface's vocabulary (the weekday header,
 * the first-day-of-week device setting, the today/selected conventions)
 * without mounting the calendar feature's own components. Items render as
 * compact chips in their day cell (node-color tint); overflow folds behind
 * a "+N" affordance whose agenda lists the full set (counts never window).
 * Read-only navigation: a chip click opens the node, shift+click peeks in
 * the sidebar. The property pick and the visible month are view-local
 * transient state, like the gantt's picks. Recurring-event expansion is the
 * calendar feature's machinery — this lens places items by their property
 * values only.
 */

import { useMemo, useState } from "react";

import { Button, Dropdown } from "../../../components/ui/kit/index.js";
import { titleOfNode } from "../../../ui/dateDisplay.js";
import { useDeviceSetting } from "../../settings/deviceSettings.js";
import { useBuilderFacts } from "../builderFacts.js";
import { registerView } from "../registry.js";
import type { NodeCollectionProps } from "../types.js";
import { todayOrdinal } from "../dateValue.js";
import {
  buildCalendarMonth,
  calendarDayOf,
  calendarMonthBounds,
  clampCalendarMonth,
  shiftCalendarMonth,
  type CalendarInputRow,
} from "./calendarModel.js";
import { WEEKDAYS } from "../../calendar/dayGrid.js";
import { weekdayLabel } from "../../calendar/calendarViewUtils.js";

import "./CalendarView.css";

/** Chips per day cell before the "+N" fold (the agenda carries the rest). */
const MAX_CHIPS_PER_CELL = 3;

const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function CalendarView({ client, items, onNodeClick, onNodeShiftClick }: NodeCollectionProps) {
  const facts = useBuilderFacts(client);
  /** The collection's date-typed bound properties (the picker vocabulary). */
  const dateProperties = useMemo(
    () => facts.boundProperties.filter((property) => property.type === "datetime"),
    [facts],
  );
  const [firstDayOfWeek] = useDeviceSetting("firstDayOfWeek", 1);

  const [propertyId, setPropertyId] = useState<string | null>(null);
  const startId = propertyId ?? dateProperties[0]?.id ?? null;

  const today = todayOrdinal();
  const todayRef = (() => {
    const stamp = new Date();
    return { year: stamp.getFullYear(), month: stamp.getMonth() + 1 };
  })();
  const [visible, setVisible] = useState(todayRef);
  const [selectedOrdinal, setSelectedOrdinal] = useState<number>(today);

  /** Items → model rows: the picked property's effective value resolves to
   *  a DAY (strict day precision — a year/month ref is not a point in
   *  time); no value = off the grid. */
  const rows = useMemo<CalendarInputRow[]>(() => {
    if (startId === null) return [];
    return (items ?? []).map((item) => {
      const effective = client.getEffectiveProperties(item.node.id);
      const entry = effective.find((property) => property.propertySchemaId === startId);
      return {
        id: item.node.id,
        name: titleOfNode(item.node) || item.node.id,
        color: item.node.color,
        day: calendarDayOf(entry?.value),
      };
    });
  }, [client, items, startId]);

  const bounds = useMemo(() => calendarMonthBounds(rows), [rows]);
  const effective = clampCalendarMonth(visible.year, visible.month, bounds);
  const grid = useMemo(
    () =>
      buildCalendarMonth(rows, effective.year, effective.month, {
        firstDayOfWeek,
        today,
      }),
    [rows, effective.year, effective.month, firstDayOfWeek, today],
  );

  const open = (id: string, shiftKey: boolean) => {
    if (shiftKey) onNodeShiftClick?.(id);
    else onNodeClick?.(id);
  };

  if (startId === null) {
    return <div className="collection-calendar collection-calendar--empty">No date property available.</div>;
  }

  const atEarliest =
    bounds.earliest !== null &&
    effective.year === bounds.earliest.year &&
    effective.month === bounds.earliest.month;
  const atLatest =
    bounds.latest !== null &&
    effective.year === bounds.latest.year &&
    effective.month === bounds.latest.month;
  const selectedCell = grid.weeks.flat().find((cell) => cell.ordinal === selectedOrdinal);
  const selectedItems = selectedCell?.items ?? [];
  const selectedLabel =
    selectedCell === undefined
      ? "Agenda"
      : (() => {
          const { year, month, day } = (() => {
            const stamp = new Date(selectedCell.ordinal * 86_400_000);
            return { year: stamp.getUTCFullYear(), month: stamp.getUTCMonth() + 1, day: stamp.getUTCDate() };
          })();
          return `${weekdayLabel(selectedCell.iso)}, ${MONTHS_LONG[month - 1]} ${day}, ${year}`;
        })();

  return (
    <div className="collection-calendar">
      <div className="collection-calendar__toolbar">
        <Dropdown
          size="sm"
          ariaLabel="Date property"
          options={dateProperties.map((property) => ({ value: property.id, label: property.name }))}
          value={startId}
          onChange={(value) => {
            if (value !== null) setPropertyId(value);
          }}
        />
        <div className="collection-calendar__nav">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon="mdi-chevron-left"
            aria-label="Previous month"
            disabled={atEarliest}
            onClick={() => setVisible(shiftCalendarMonth(effective.year, effective.month, -1))}
          />
          <span className="collection-calendar__title" aria-live="polite">
            {MONTHS_LONG[effective.month - 1]} {effective.year}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon="mdi-chevron-right"
            aria-label="Next month"
            disabled={atLatest}
            onClick={() => setVisible(shiftCalendarMonth(effective.year, effective.month, 1))}
          />
        </div>
      </div>
      <div className="collection-calendar__weekdays" aria-hidden="true">
        {Array.from({ length: 7 }, (_, index) => WEEKDAYS[(firstDayOfWeek + index) % 7]!).map(
          (name, index) => (
            <span key={`${name}-${index}`} className="collection-calendar__weekday">
              {name}
            </span>
          ),
        )}
      </div>
      <div className="collection-calendar__grid">
        {grid.weeks.flat().map((cell) => (
          <div
            key={cell.iso}
            data-iso={cell.iso}
            className={`collection-calendar__cell${
              cell.inMonth ? "" : " collection-calendar__cell--out"
            }${cell.isToday ? " collection-calendar__cell--today" : ""}${
              cell.ordinal === selectedOrdinal ? " collection-calendar__cell--selected" : ""
            }`}
            role="button"
            tabIndex={-1}
            aria-label={cell.iso}
            onClick={() => setSelectedOrdinal(cell.ordinal)}
          >
            <span className="collection-calendar__day">{cell.day}</span>
            <div className="collection-calendar__chips">
              {cell.items.slice(0, MAX_CHIPS_PER_CELL).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="collection-calendar__chip"
                  data-node-id={item.id}
                  title={item.name}
                  onClick={(event) => {
                    event.stopPropagation();
                    open(item.id, event.shiftKey);
                  }}
                >
                  <span
                    className="collection-calendar__chip-tint"
                    style={item.color !== null ? { backgroundColor: item.color } : {}}
                  />
                  <span className="collection-calendar__chip-name">{item.name}</span>
                </button>
              ))}
              {cell.items.length > MAX_CHIPS_PER_CELL && (
                <button
                  type="button"
                  className="collection-calendar__chip collection-calendar__chip--more"
                  onClick={(event) => {
                    event.stopPropagation();
                    // The fold selects the day: the agenda lists the FULL
                    // set (counts never window).
                    setSelectedOrdinal(cell.ordinal);
                  }}
                >
                  +{cell.items.length - MAX_CHIPS_PER_CELL}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="collection-calendar__agenda" aria-live="polite">
        <div className="collection-calendar__agenda-title">{selectedLabel}</div>
        {selectedItems.length === 0 ? (
          <div className="collection-calendar__agenda-empty">Nothing scheduled this day.</div>
        ) : (
          selectedItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className="collection-calendar__agenda-row"
              onClick={(event) => open(item.id, event.shiftKey)}
            >
              <span
                className="collection-calendar__chip-tint"
                style={item.color !== null ? { backgroundColor: item.color } : {}}
              />
              {item.name}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

registerView({
  id: "calendar",
  label: "Calendar",
  icon: "mdi-calendar-month",
  component: CalendarView,
  tier: "secondary",
  // A collection offers the calendar only when a date property carries a
  // value (no date → no grid → a dead option).
  availability: (ctx) => ctx.datePropertyCount >= 1,
  capabilities: {},
});
