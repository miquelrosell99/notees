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
 * Interactions (owner 2026-10-24, refining the Google click-to-create
 * register): a SINGLE CLICK on an empty hour area spawns an inline GHOST
 * card — an outline-register shell positioned like a timed event, carrying
 * an autofocused title field, a button into the detailed EventCreateModal,
 * and top/bottom resize handles (30-minute snap). The click's hour row
 * anchors a 1-hour span; a click within the small divider hit zone around
 * an hour boundary anchors the half-hour offset (HH:30 – HH+1:30). Enter
 * confirms (empty text cancels), Escape or clicking elsewhere dismisses.
 * Grid-body clicks no longer select the day column — the header day-number
 * button owns selection. A dblclick on an hour still opens the event
 * creation modal prefilled with that day AND that hour; block drag-move
 * rewrites the value's day/time preserving the duration (timed drops
 * re-anchor the start; band drops shift the day, preserving the
 * time-of-day); the right-click menu and the recurring scope sheet ride the
 * shared calendarEventOps register.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { SYSTEM_CLASS_UUIDS, dayNodeId, deriveDisplayName } from "@notees/domain";

import { Button } from "../../components/ui/fleet/Button.js";
import { Input } from "../../components/ui/fleet/Input.js";
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

/** The resize snap (the Google register): ghost drags land on :00/:30. */
const SNAP_MINUTES = 30;

/** The divider hit zone: a click within ±3px of an hour boundary anchors the
    ghost at the half hour (the HH:30 – HH+1:30 register). */
const DIVIDER_HIT_PX = 3;

/** The dblclick-to-create target: a day column at an hour (null time = the
    all-day band's untimed register). */
interface CreateTarget {
  iso: string;
  time: string | null;
  /** The ghost card's end ("HH:MM") — prefills the modal's end time. */
  endTime?: string;
}

/** The click-to-create ghost: a day + a provisional timed span (minutes). */
interface GhostTarget {
  iso: string;
  start: number;
  end: number;
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
  /** Day pick: select the day (the header day-number button — grid-body
      clicks spawn the ghost, they no longer select). */
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
  /** The click-to-create ghost (null = no ghost rides the grid). */
  const [ghost, setGhost] = useState<GhostTarget | null>(null);

  /** A grid-body click anchors the ghost: the clicked hour row gives a
      1-hour span; the small hit zone around an hour boundary gives the
      half-hour offset. Clamped to the day (start < end, end ≤ 24:00). */
  const anchorGhost = (event: React.MouseEvent, iso: string): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    const y = event.clientY - rect.top;
    if (rect.height <= 0 || y < 0 || y > rect.height) return;
    const minutes = (y / rect.height) * MINUTES_PER_DAY;
    const hour = Math.min(Math.floor(minutes / 60), HOURS.length - 1);
    const hourHeightPx = rect.height / HOURS.length;
    const intoHour = minutes - hour * 60;
    const dividerDistPx = (Math.min(intoHour, 60 - intoHour) / 60) * hourHeightPx;
    const start = dividerDistPx <= DIVIDER_HIT_PX ? hour * 60 + 30 : hour * 60;
    setGhost({
      iso,
      start: Math.min(start, MINUTES_PER_DAY - SNAP_MINUTES),
      end: Math.min(start + 60, MINUTES_PER_DAY),
    });
  };

  /** The ghost's border resize: the dragged edge re-anchors at the 30-minute
      snap, guarding start < end (a 30-minute floor) and the day bounds. */
  const resizeGhost = (edge: "top" | "bottom", minutes: number): void => {
    setGhost((current) => {
      if (current === null) return current;
      const clamped = Math.max(0, Math.min(MINUTES_PER_DAY, minutes));
      if (edge === "top") {
        return { ...current, start: Math.max(0, Math.min(clamped, current.end - SNAP_MINUTES)) };
      }
      return { ...current, end: Math.min(MINUTES_PER_DAY, Math.max(clamped, current.start + SNAP_MINUTES)) };
    });
  };

  /** Enter on the ghost's title: the EventCreateModal write register — an
      `event`-classed node named by its content, the system event class's
      first datetime binding carrying the same-day timed range. An empty
      confirm cancels (the text IS the content); a failure keeps the ghost
      so the typed title survives for a retry. */
  const confirmGhost = async (title: string): Promise<void> => {
    if (ghost === null) return;
    const trimmed = title.trim();
    if (trimmed === "") {
      setGhost(null);
      return;
    }
    const { iso, start, end } = ghost;
    try {
      await client.ensureDateChain(iso);
      const id = await client.createObject({
        isEmbedded: false,
        classIds: [SYSTEM_CLASS_UUIDS.event],
        name: trimmed,
      });
      const schemaId = client
        .getClassBindings(SYSTEM_CLASS_UUIDS.event)
        .map((binding) => binding.propertySchemaId)
        .find((bindingSchemaId) => bindingSchemaId !== undefined);
      if (schemaId !== undefined) {
        const slot = (minutes: number): { nodeId: string; time: string } => ({
          nodeId: dayNodeId(iso),
          time: timeOfMinutes(minutes),
        });
        await client.setProperty(id, schemaId, { start: slot(start), end: slot(end) }, 0);
      }
      setGhost(null);
      onOpenEvent(id);
    } catch {
      // The ghost stays open — the title survives and the span can retry.
    }
  };

  /** The ghost's modal button (or a click on the ghost shell): dismiss the
      ghost and open the detailed modal prefilled with the ghost's span. */
  const openModalFromGhost = (): void => {
    if (ghost === null) return;
    const { iso, start, end } = ghost;
    setGhost(null);
    setCreateAt({ iso, time: timeOfMinutes(start), endTime: timeOfMinutes(end) });
  };

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
                onClick={() => {
                  // The header day-number button owns day selection (the
                  // grid-body click spawns the ghost instead).
                  onSelectDay(iso);
                  onOpenDayPage(iso);
                }}
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
                onClick={(event) => {
                  // A plain click spawns (or re-anchors) the ghost — the
                  // day column is no longer selected by a grid-body click.
                  // Cards and the ghost shell swallow their own clicks.
                  if (createAt !== null) return;
                  if (
                    (event.target as HTMLElement).closest(
                      ".cal-timegrid__card, button, input, .cal-timegrid__ghost",
                    )
                  ) {
                    return;
                  }
                  anchorGhost(event, iso);
                }}
                onDoubleClick={(event) => {
                  // Dblclick-to-create at the dblclicked HOUR: the column's
                  // geometry maps the click to an hour row (never on a
                  // card — a card dblclick opens the event instead). A
                  // dblclick riding on a ghost dismissal (the second click
                  // opened the modal with the ghost's span) is ignored.
                  if (createAt !== null) return;
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
                {ghost !== null && ghost.iso === iso && (
                  <CreateGhost
                    start={ghost.start}
                    end={ghost.end}
                    onResize={resizeGhost}
                    onConfirm={(title) => void confirmGhost(title)}
                    onCancel={() => setGhost(null)}
                    onOpenModal={openModalFromGhost}
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
        endTime={createAt?.endTime ?? ""}
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

/**
 * CreateGhost — the click-to-create ghost card (owner 2026-10-24, the Google
 * register): an outline/dashed shell positioned like a timed event over the
 * clicked day column. The autofocused title field confirms on Enter (empty
 * = cancel) and dismisses on Escape; the trailing button opens the detailed
 * EventCreateModal with the ghost's span; the top/bottom borders are resize
 * handles snapping to 30 minutes. A click on the shell itself (the dblclick
 * second-click register) rides the same modal path.
 */
function CreateGhost({
  start,
  end,
  onResize,
  onConfirm,
  onCancel,
  onOpenModal,
}: {
  start: number;
  end: number;
  onResize: (edge: "top" | "bottom", minutes: number) => void;
  onConfirm: (title: string) => void;
  onCancel: () => void;
  onOpenModal: () => void;
}) {
  const [title, setTitle] = useState("");

  /** A border press tracks the mouse on the window until the release,
      mapping clientY back to column minutes (snapped by the host). */
  const beginResize = (edge: "top" | "bottom") => (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const column = (event.currentTarget as HTMLElement).closest(".cal-timegrid__day");
    if (!(column instanceof HTMLElement)) return;
    const rect = column.getBoundingClientRect();
    const onMove = (move: MouseEvent): void => {
      if (rect.height <= 0) return;
      const raw = ((move.clientY - rect.top) / rect.height) * MINUTES_PER_DAY;
      onResize(edge, Math.round(raw / SNAP_MINUTES) * SNAP_MINUTES);
    };
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      className="cal-timegrid__ghost"
      data-start={start}
      data-end={end}
      style={{
        top: `${(start / MINUTES_PER_DAY) * 100}%`,
        height: `${((end - start) / MINUTES_PER_DAY) * 100}%`,
      }}
      onClick={(event) => {
        // The ghost swallows every click; only the bare shell (not the
        // field, button, or resize handles inside it) routes to the modal —
        // the dblclick second-click lands here. Stopping the bubble keeps
        // the column's click-to-anchor handler from respawning a ghost
        // behind the modal.
        event.stopPropagation();
        if ((event.target as HTMLElement).closest("input, button, .cal-timegrid__ghost-handle")) {
          return;
        }
        onOpenModal();
      }}
    >
      <div
        className="cal-timegrid__ghost-handle cal-timegrid__ghost-handle--top"
        onMouseDown={beginResize("top")}
      />
      <Input
        size="sm"
        autoFocus
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onConfirm(title);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        placeholder="Add title"
        aria-label="Event title"
        autoComplete="off"
      />
      <Button
        size="sm"
        variant="outline"
        icon="mdi-dots-horizontal"
        aria-label="More options"
        onClick={(event) => {
          event.stopPropagation();
          onOpenModal();
        }}
      />
      <span className="cal-timegrid__ghost-time">
        {timeOfMinutes(start)} – {timeOfMinutes(end)}
      </span>
      <div
        className="cal-timegrid__ghost-handle cal-timegrid__ghost-handle--bottom"
        onMouseDown={beginResize("bottom")}
      />
    </div>
  );
}
