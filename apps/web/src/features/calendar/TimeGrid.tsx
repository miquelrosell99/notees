/**
 * TimeGrid — the Calendar Day and Week zooms (owner 2026-10-24, the
 * Google time-grid register): a constant 1-hour interval grid replacing
 * both the old Week block grid and the day agenda. A header row wears the
 * weekday abbreviations + the big day numbers (today gets the highlighted
 * ring; the day number opens the day page), an ALL-DAY BAND above the hour
 * grid stacks untimed events as chips and paints multi-day events as ONE
 * CONTINUOUS BAR across their covered columns, and the hour grid renders
 * 24 hours per day column with the timed events as absolutely-positioned
 * cards (top = start minutes / 60 × the hour height, height = the
 * duration — a timed point without an end = the 1h default). Overlapping
 * events split side by side (the interval-graph clustering:
 * calendarViewUtils.clusterTimedEvents). A red now-line rides today's
 * column at the current wall-clock minutes (re-rendered once a minute).
 *
 * Interactions: a dblclick on an hour opens the event creation modal
 * prefilled with that day AND that hour; block drag-move rewrites the
 * value's day/time preserving the duration (timed drops re-anchor the
 * start; band drops shift the day, preserving the time-of-day); the
 * right-click menu and the recurring scope sheet ride the shared
 * calendarEventOps register.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { deriveDisplayName } from "@notees/domain";

import { cssColorFor } from "../../components/ui/fleet/colorPresets.js";
import { displayNameFromClient } from "../../ui/dateDisplay.js";
import { untitledLabelOf } from "../../ui/renderStateLabel.js";
import type { AnyClient } from "../../ui/app/Sidebar.js";
import {
  eventRowsForDays,
  timeGridSplitForDays,
  type RecurringRow,
  type SpannedRow,
  type TimedRow,
} from "./calendarRows.js";
import {
  clusterTimedEvents,
  timeOfMinutes,
  todayIsoLocal,
} from "./calendarViewUtils.js";
import { WEEKDAYS } from "./dayGrid.js";
import { BlockContextMenu, useEventOps } from "./calendarEventOps.js";
import { EventCreateModal } from "./EventCreateModal.js";
import "./TimeGrid.css";

/** The hour labels + hour rows: the constant 1-hour interval register. */
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** Minutes per day — the percentage math's divisor. */
const MINUTES_PER_DAY = 24 * 60;

/** The dblclick-to-create target: a day column at an hour (null time = the
    all-day band's untimed register). */
interface CreateTarget {
  iso: string;
  time: string | null;
}

export interface TimeGridProps {
  client: AnyClient;
  /** The visible days (the Day zoom = 1, the Week zoom = 7). */
  days: readonly string[];
  /** The selected day (local YYYY-MM-DD) — outlined in the header. */
  selectedIso: string;
  /** The recurring series scan (the caller's memo — the read model input). */
  recurringRows: readonly RecurringRow[];
  /** The multi-day span scan (same register). */
  spannedRows: readonly SpannedRow[];
  /** Day pick: select the day (a column click). */
  onSelectDay: (iso: string) => void;
  /** Card/chip click: open the event node. */
  onOpenEvent: (nodeId: string) => void;
  /** The day-number register: open the day's page (chain ensured by the host). */
  onOpenDayPage: (iso: string) => void;
}

export function TimeGrid({
  client,
  days,
  selectedIso,
  recurringRows,
  spannedRows,
  onSelectDay,
  onOpenEvent,
  onOpenDayPage,
}: TimeGridProps) {
  const zoom = days.length === 1 ? "day" : "week";
  const todayIso = todayIsoLocal();
  const ops = useEventOps(client);
  const [createAt, setCreateAt] = useState<CreateTarget | null>(null);

  // The red now-line: one re-render per minute, cleaned up with the grid.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  const rowsByIso = useMemo(() => {
    const map = new Map<string, ReturnType<typeof eventRowsForDays>>();
    for (const iso of days) {
      map.set(iso, eventRowsForDays(client, [iso], recurringRows, spannedRows));
    }
    return map;
  }, [client, days, recurringRows, spannedRows]);

  // The band/grid split (calendarRows.timeGridSplitForDays — the membership
  // register: untimed + cross-day events to the band, single-day timed to
  // the hour grid with their placement facts).
  const splits = useMemo(
    () =>
      timeGridSplitForDays(
        client,
        days,
        (iso) => rowsByIso.get(iso) ?? [],
        spannedRows,
      ),
    [client, days, rowsByIso, spannedRows],
  );

  // Scroll-init to ~07:00 once the body can measure itself (jsdom reports
  // zero geometry — the guard no-ops there).
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrolledRef = useRef(false);
  useLayoutEffect(() => {
    if (scrolledRef.current) return;
    const el = bodyRef.current;
    if (el === null) return;
    const column = el.querySelector(".cal-timegrid__day");
    if (!(column instanceof HTMLElement)) return;
    const height = column.getBoundingClientRect().height;
    if (height <= 0) return;
    scrolledRef.current = true;
    el.scrollTop = 7 * (height / HOURS.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the init runs once per days change until it measures
  }, [days]);

  /** The drag payload decode shared by every drop target. */
  const dropPayload = (event: React.DragEvent): { nodeId: string; fromIso: string } | null => {
    const payload = event.dataTransfer.getData("text/x-notees-event");
    if (payload === "") return null;
    const [nodeId, fromIso] = payload.split("|");
    return nodeId !== undefined && fromIso !== undefined ? { nodeId, fromIso } : null;
  };

  return (
    <section
      className={`cal-timegrid cal-timegrid--${zoom}`}
      aria-label={`Calendar ${zoom} view`}
    >
      {/* The header: weekday abbreviations + the big day numbers; today
          wears the highlighted ring, the number opens the day page. */}
      <div className="cal-timegrid__header">
        <div className="cal-timegrid__corner" aria-hidden="true" />
        {days.map((iso) => {
          const weekday = WEEKDAYS[new Date(`${iso}T12:00:00`).getDay()];
          return (
            <div
              key={iso}
              className={`cal-timegrid__head${iso === todayIso ? " cal-timegrid__head--today" : ""}`}
            >
              <span className="cal-timegrid__weekday">{weekday}</span>
              <button
                type="button"
                className={`cal-timegrid__daynum${
                  iso === todayIso ? " cal-timegrid__daynum--today" : ""
                }${iso === selectedIso ? " cal-timegrid__daynum--selected" : ""}`}
                aria-label={`Open day page ${iso}`}
                onClick={() => onOpenDayPage(iso)}
              >
                {Number(iso.slice(8))}
              </button>
            </div>
          );
        })}
      </div>

      {/* The all-day band: untimed events stack as chips in their day's
          cell; multi-day events paint one continuous bar across the
          covered columns (a CSS-grid item spanning its column range). */}
      <div className="cal-timegrid__band">
        <div className="cal-timegrid__band-gutter">All day</div>
        <div className="cal-timegrid__band-grid">
          {days.map((iso, i) => (
            <div
              key={iso}
              className="cal-timegrid__band-cell"
              data-day={iso}
              style={{ gridColumn: `${i + 1}` }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const payload = dropPayload(event);
                if (payload !== null) {
                  ops.moveEventToDay(payload.nodeId, payload.fromIso, iso);
                }
              }}
              onDoubleClick={(event) => {
                if ((event.target as HTMLElement).closest(".cal-timegrid__chip, .cal-timegrid__span, button")) {
                  return;
                }
                setCreateAt({ iso, time: null });
              }}
            >
              {splits[i]!.chips.map((chip) => (
                <BandChip
                  key={chip.node.id}
                  client={client}
                  nodeId={chip.node.id}
                  iso={iso}
                  onOpen={() => onOpenEvent(chip.node.id)}
                  onMenu={(x, y) => ops.setMenu({ x, y, nodeId: chip.node.id, iso })}
                />
              ))}
            </div>
          ))}
          {splits.flatMap((split) =>
            split.spans.map((span) => (
              <BandSpan
                key={span.node.id}
                client={client}
                nodeId={span.node.id}
                startIso={span.startIso}
                fromIndex={span.fromIndex}
                toIndex={span.toIndex}
                onOpen={() => onOpenEvent(span.node.id)}
                onMenu={(x, y) =>
                  ops.setMenu({ x, y, nodeId: span.node.id, iso: span.startIso })
                }
              />
            )),
          )}
        </div>
      </div>

      {/* The hour grid: 24 hour rows per day column; timed events paint as
          absolutely-positioned cards over the hour cells. */}
      <div className="cal-timegrid__body" ref={bodyRef}>
        <div className="cal-timegrid__hours">
          <div className="cal-timegrid__hour-gutter" aria-hidden="true">
            {HOURS.map((hour) => (
              <span key={hour} className="cal-timegrid__hour-label">
                {timeOfMinutes(hour * 60)}
              </span>
            ))}
          </div>
          {days.map((iso, i) => {
            const placements = clusterTimedEvents(splits[i]!.timed);
            return (
              <div
                key={iso}
                className={`cal-timegrid__day${
                  iso === todayIso ? " cal-timegrid__day--today" : ""
                }${iso === selectedIso ? " cal-timegrid__day--selected" : ""}`}
                data-day={iso}
                onClick={() => onSelectDay(iso)}
                onDoubleClick={(event) => {
                  // Dblclick-to-create at the dblclicked HOUR: the column's
                  // geometry maps the click to an hour row (never on a
                  // card — a card dblclick opens the event instead).
                  if (
                    (event.target as HTMLElement).closest(
                      ".cal-timegrid__card, button",
                    )
                  ) {
                    return;
                  }
                  const rect = event.currentTarget.getBoundingClientRect();
                  const y = event.clientY - rect.top;
                  if (rect.height <= 0 || y < 0 || y > rect.height) return;
                  const hour = Math.floor((y / rect.height) * HOURS.length);
                  setCreateAt({ iso, time: timeOfMinutes(hour * 60) });
                }}
              >
                {HOURS.map((hour) => (
                  <div
                    key={hour}
                    className="cal-timegrid__hour"
                    data-hour={hour}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      const payload = dropPayload(event);
                      if (payload !== null) {
                        ops.moveEventToTime(payload.nodeId, payload.fromIso, iso, hour * 60);
                      }
                    }}
                  />
                ))}
                <div className="cal-timegrid__events">
                  {placements.map((placement) => (
                    <TimedCard
                      key={placement.row.node.id}
                      client={client}
                      row={placement.row}
                      column={placement.column}
                      columns={placement.columns}
                      iso={iso}
                      onOpen={() => onOpenEvent(placement.row.node.id)}
                      onMenu={(x, y) =>
                        ops.setMenu({ x, y, nodeId: placement.row.node.id, iso })
                      }
                    />
                  ))}
                </div>
                {iso === todayIso && (
                  <div
                    className="cal-timegrid__now"
                    data-minutes={nowMinutes}
                    style={{ top: `${(nowMinutes / MINUTES_PER_DAY) * 100}%` }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {ops.menu !== null && (
        <BlockContextMenu
          menu={ops.menu}
          onOpen={onOpenEvent}
          onDelete={ops.requestDelete}
          onCancel={() => ops.setMenu(null)}
        />
      )}
      {ops.scopeSheet}
      <EventCreateModal
        isOpen={createAt !== null}
        onClose={() => setCreateAt(null)}
        client={client}
        startIso={createAt?.iso ?? selectedIso}
        startTime={createAt?.time ?? ""}
        onCreated={(nodeId) => {
          setCreateAt(null);
          onOpenEvent(nodeId);
        }}
      />
    </section>
  );
}

/** The title register shared by every band/grid element (title-is-content). */
function eventLabelOf(client: AnyClient, nodeId: string): string {
  const node = client.getNode(nodeId);
  if (node === undefined) return "";
  return (
    deriveDisplayName(node, (classId) => displayNameFromClient(client, classId)) ||
    untitledLabelOf(node)
  );
}

/** One single-day untimed chip in the all-day band. */
function BandChip({
  client,
  nodeId,
  iso,
  onOpen,
  onMenu,
}: {
  client: AnyClient;
  nodeId: string;
  iso: string;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const node = client.getNode(nodeId);
  if (node === undefined) return null;
  const label = eventLabelOf(client, nodeId);
  const color = client.effectiveNodeColor(node);
  return (
    <button
      type="button"
      className="cal-timegrid__chip"
      style={color !== null ? { background: color, color: cssColorFor(color) } : undefined}
      title={label}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("text/x-notees-event", `${nodeId}|${iso}`);
        event.dataTransfer.effectAllowed = "move";
      }}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onMenu(event.clientX, event.clientY);
      }}
    >
      {label}
    </button>
  );
}

/** One multi-day span bar: a continuous chip across the covered columns. */
function BandSpan({
  client,
  nodeId,
  startIso,
  fromIndex,
  toIndex,
  onOpen,
  onMenu,
}: {
  client: AnyClient;
  nodeId: string;
  startIso: string;
  fromIndex: number;
  toIndex: number;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const node = client.getNode(nodeId);
  if (node === undefined) return null;
  const label = eventLabelOf(client, nodeId);
  const color = client.effectiveNodeColor(node);
  return (
    <button
      type="button"
      className="cal-timegrid__span"
      data-span-from={fromIndex}
      data-span-to={toIndex}
      style={{
        gridColumn: `${fromIndex + 1} / ${toIndex + 2}`,
        ...(color !== null ? { background: color, color: cssColorFor(color) } : {}),
      }}
      title={label}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("text/x-notees-event", `${nodeId}|${startIso}`);
        event.dataTransfer.effectAllowed = "move";
      }}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onMenu(event.clientX, event.clientY);
      }}
    >
      {label}
    </button>
  );
}

/** One timed event card: top/height from the placement facts (minutes →
    percentages of the 24h column), left/width from the overlap cluster. */
function TimedCard({
  client,
  row,
  column,
  columns,
  iso,
  onOpen,
  onMenu,
}: {
  client: AnyClient;
  row: TimedRow;
  column: number;
  columns: number;
  iso: string;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const label = eventLabelOf(client, row.node.id);
  const color = client.effectiveNodeColor(row.node);
  const top = (row.startMinutes / MINUTES_PER_DAY) * 100;
  const height = (row.durationMinutes / MINUTES_PER_DAY) * 100;
  const left = (column / columns) * 100;
  const width = 100 / columns;
  return (
    <button
      type="button"
      className="cal-timegrid__card"
      data-start={row.startMinutes}
      data-duration={row.durationMinutes}
      data-column={column}
      data-columns={columns}
      style={{
        top: `${top}%`,
        height: `${height}%`,
        left: `calc(${left}% + 1px)`,
        width: `calc(${width}% - 2px)`,
        ...(color !== null ? { background: color, color: cssColorFor(color) } : {}),
      }}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("text/x-notees-event", `${row.node.id}|${iso}`);
        event.dataTransfer.effectAllowed = "move";
      }}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onMenu(event.clientX, event.clientY);
      }}
    >
      <span className="cal-timegrid__card-title">{label}</span>
      <span className="cal-timegrid__card-time">
        {timeOfMinutes(row.startMinutes)} – {timeOfMinutes(row.startMinutes + row.durationMinutes)}
      </span>
    </button>
  );
}
