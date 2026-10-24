/**
 * CalendarGrid — the calendar's Month / Year zooms (owner 2026-10-23, the
 * google-calendar proposal slice 2; the Day/Week zooms re-scoped to the
 * TimeGrid 2026-10-24): each rendering the events list's exact membership
 * (calendarRows.eventRowsForDays — event-family nodes dated into the day
 * or embedded in the day page) as COLORED BLOCKS (effectiveNodeColor: own
 * color, else the first class's). The Day/Week time grid (TimeGrid) owns
 * the hourly register; this component owns the block grids.
 *
 * The whole-day register retired (owner 2026-10-24): a datetime value may
 * carry a clock time and span a RANGE of days — blocks prefix the label
 * with the driving value's time, and a range value paints its span across
 * every covered day (calendarRows.spannedRowsOf expands it at read time,
 * the same compute-on-read register as recurrence).
 *
 * Interactions (the Google register): a block click opens the event; the
 * day-number opens the day PAGE (owner ruling 2026-10-23); clicking
 * elsewhere in a cell selects the day; month cells cap the visible blocks
 * (BLOCKS_PER_CELL) with an honest "+N" that jumps to the day zoom; a
 * DBLCLICK on a cell's empty area opens the event creation modal
 * (owner 2026-10-24 — it never fights the press-drag create: the drag
 * commits only across days, the dblclick arrives on a same-day click
 * pair). Blocks wear the driving value's clock time when it carries one
 * ("14:30 Title"; "14:30–16:00 Title" for a same-day timed range).
 * Period navigation (prev/next) steps the VISIBLE window without moving
 * the selection; the window follows the selection when it drifts across a
 * boundary (the MonthCalendar contract). Drag-and-drop (move/create),
 * the context menu, and the recurring scope dialog ride the shared
 * calendarEventOps register; the grid renders their drop targets already
 * via the cell data attributes.
 */

import { useEffect, useMemo, useState } from "react";

import { Button } from "../../components/ui/fleet/Button.js";
import { cssColorFor } from "../../components/ui/fleet/colorPresets.js";
import { displayNameFromClient } from "../../ui/dateDisplay.js";
import { untitledLabelOf } from "../../ui/renderStateLabel.js";
import type { AnyClient } from "../../ui/app/Sidebar.js";
import {
  eventRowsForDays,
  drivingDateRowOf,
  type RecurringRow,
  type SpannedRow,
} from "./calendarRows.js";
import { BlockContextMenu, useEventOps } from "./calendarEventOps.js";
import {
  dayNodeId,
  deriveDisplayName,
  SYSTEM_CLASS_UUIDS,
} from "@notees/domain";
import { isoLocal, useWeekdayHeader } from "./dayGrid.js";
import { addDaysIso, timePrefixOfValue } from "./calendarViewUtils.js";
import { EventCreateModal } from "./EventCreateModal.js";
import "./CalendarGrid.css";

/** Blocks a month cell shows before the honest "+N" row. */
const BLOCKS_PER_CELL = 3;

export type GridZoom = "month" | "year";

export interface CalendarGridProps {
  client: AnyClient;
  zoom: GridZoom;
  /** The selected day (local YYYY-MM-DD) — outlined, anchors the week zoom. */
  selectedIso: string;
  firstDayOfWeek: number;
  /** The recurring series scan (the caller's memo — the read model input). */
  recurringRows: readonly RecurringRow[];
  /** The multi-day span scan (same register — endDate-carrying date values). */
  spannedRows: readonly SpannedRow[];
  /** The visible period (the host's state — the navigator lives in the top bar). */
  period: VisiblePeriod;
  /** Day pick: select the day (a cell click; the "+N" row jumps with it). */
  onSelectDay: (iso: string) => void;
  /** Block click: open the event node. */
  onOpenEvent: (nodeId: string) => void;
  /** The day-number register: open the day's page (chain ensured by the host). */
  onOpenDayPage: (iso: string) => void;
  /** Year zoom: open a month (the host switches the zoom + selects its first day). */
  onOpenMonth: (year: number, month0: number) => void;
  /** The title-button register (panel/popup parity): open the monthly page. */
  onOpenMonthPage: (year: number, month0: number) => void;
  /** The title-button register: open the yearly page. */
  onOpenYearPage: (year: number) => void;
}

/** The visible-period window — owned by the HOST since the navigator
 * lifted into the top bar (owner 2026-10-24). */
export interface VisiblePeriod {
  year: number;
  month0: number;
}

export function periodOf(iso: string): VisiblePeriod {
  const [y, m] = iso.split("-").map(Number);
  return { year: y!, month0: m! - 1 };
}

export function shiftMonth(period: VisiblePeriod, delta: number): VisiblePeriod {
  const total = period.year * 12 + period.month0 + delta;
  return { year: Math.floor(total / 12), month0: total % 12 };
}

export function CalendarGrid({
  client,
  zoom,
  selectedIso,
  firstDayOfWeek,
  recurringRows,
  spannedRows,
  period,
  onSelectDay,
  onOpenEvent,
  onOpenDayPage,
  onOpenMonth,
  onOpenMonthPage,
  onOpenYearPage,
}: CalendarGridProps) {

  /** The recurring scope dialog + context menu ride the shared ops register. */
  const {
    menu: blockMenu,
    setMenu: setBlockMenu,
    moveEventToDay,
    requestDelete,
    scopeSheet,
  } = useEventOps(client);
  /** Drag-create anchor: the day the press started on (null = not creating). */
  const [createAnchor, setCreateAnchor] = useState<string | null>(null);
  const [createEnd, setCreateEnd] = useState<string | null>(null);
  /** The dblclick-to-create target day (the event modal opens over it). */
  const [createAt, setCreateAt] = useState<string | null>(null);

  const weekdayHeader = useWeekdayHeader(firstDayOfWeek);
  const todayIso = (() => {
    const now = new Date();
    return isoLocal(now.getFullYear(), now.getMonth(), now.getDate());
  })();

  // The rendered day cells + the events read per cell. Month shows the
  // whole visible month plus lead/trail days of the neighbors (Google's
  // register: neighbor days render dimmed); the year zoom renders its own
  // compact months.
  const cells = useMemo(() => {
    if (zoom === "month") {
      const lead = (new Date(period.year, period.month0, 1).getDay() - firstDayOfWeek + 7) % 7;
      const dayCount = new Date(period.year, period.month0 + 1, 0).getDate();
      const total = lead + dayCount;
      const trail = (7 - (total % 7)) % 7;
      const from = addDaysIso(isoLocal(period.year, period.month0, 1), -lead);
      return Array.from({ length: total + trail }, (_, i) => addDaysIso(from, i));
    }
    return [];
  }, [zoom, firstDayOfWeek, period]);

  const eventsByIso = useMemo(() => {
    const map = new Map<string, ReturnType<typeof eventRowsForDays>>();
    for (const iso of cells) map.set(iso, eventRowsForDays(client, [iso], recurringRows, spannedRows));
    return map;
  }, [client, cells, recurringRows, spannedRows]);

  // --- the drag-create write (owner 2026-10-23, google-calendar slice 3) ---

  /** Drag-create release: one plain `event`-classed object, a date value per
      dragged day (the multi-day register: PG5 multi-value, one value per
      day — blocks render on every dragged day, same node). */
  const commitCreate = async (fromIso: string, toIso: string): Promise<void> => {
    const [a, b] = fromIso <= toIso ? [fromIso, toIso] : [toIso, fromIso];
    const days: string[] = [];
    for (let iso = a; iso <= b; iso = addDaysIso(iso, 1)) days.push(iso);
    for (const iso of days) await client.ensureDateChain(iso);
    const id = await client.createObject({
      isEmbedded: false,
      classIds: [SYSTEM_CLASS_UUIDS.event],
    });
    // The driving date schema: the system event class's first datetime binding.
    const schemaId = client
      .getClassBindings(SYSTEM_CLASS_UUIDS.event)
      .map((binding) => binding.propertySchemaId)
      .find((bindingSchemaId) => bindingSchemaId !== undefined);
    if (schemaId !== undefined) {
      // One value per drag day; a multi-day drag also stamps the endDate
      // span metadata (the datetime-range ruling) so reads expand the range.
      for (let idx = 0; idx < days.length; idx += 1) {
        const metadata =
          days.length > 1 && idx === 0 ? { endDate: days[days.length - 1]! } : undefined;
        await client.setProperty(id, schemaId, { nodeId: dayNodeId(days[idx]!) }, idx, metadata);
      }
    }
    onSelectDay(a);
    onOpenEvent(id);
  };

  if (zoom === "year") {
    return (
      <YearGrid
        client={client}
        year={period.year}
        selectedIso={selectedIso}
        todayIso={todayIso}
        eventsByIsoReader={(iso) => eventRowsForDays(client, [iso], recurringRows, spannedRows)}
        onOpenMonth={(month0) => onOpenMonth(period.year, month0)}
        onOpenDayPage={onOpenDayPage}
        onOpenYearPage={onOpenYearPage}
        onCreateEvent={(iso) => setCreateAt(iso)}
      />
    );
  }

  // The period label rides the host's top bar; the grid renders cells only.
  return (
    <section className="cal-grid" aria-label={`Calendar ${zoom} view`}>
      <div className="cal-grid__weekdays">
        {weekdayHeader.map((name, i) => (
          <span key={`${name}-${i}`} className="cal-grid__weekday">
            {name}
          </span>
        ))}
      </div>
      <div className="cal-grid__cells">
        {cells.map((iso) => {
          const inMonth = Number(iso.slice(5, 7)) === period.month0 + 1;
          const rows = eventsByIso.get(iso) ?? [];
          const shown = rows.slice(0, BLOCKS_PER_CELL);
          const extra = rows.length - shown.length;
          return (
            <div
              key={iso}
              className={`cal-grid__cell${inMonth ? "" : " cal-grid__cell--outside"}${
                iso === todayIso ? " cal-grid__cell--today" : ""
              }${iso === selectedIso ? " cal-grid__cell--selected" : ""}${
                createAnchor !== null && createEnd !== null && iso >= (createAnchor <= createEnd ? createAnchor : createEnd) && iso <= (createAnchor <= createEnd ? createEnd : createAnchor)
                  ? " cal-grid__cell--creating"
                  : ""
              }`}
              data-day={iso}
              onClick={() => onSelectDay(iso)}
              onDoubleClick={(event) => {
                // Dblclick-to-create on the cell's empty area: never on
                // blocks, the day number, the "+N more" row, or buttons —
                // and never mid drag-create (the press owns the gesture;
                // a same-day click pair commits no drag, so the two never
                // fight).
                if (createAnchor !== null) return;
                if (
                  (event.target as HTMLElement).closest(
                    ".cal-block, .cal-grid__daynum, .cal-grid__more, button",
                  )
                ) {
                  return;
                }
                setCreateAt(iso);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const payload = event.dataTransfer.getData("text/x-notees-event");
                if (payload === "") return;
                const [nodeId, fromIso] = payload.split("|");
                if (nodeId !== undefined && fromIso !== undefined) moveEventToDay(nodeId, fromIso, iso);
              }}
              onMouseDown={(event) => {
                // Drag-create: a press on the empty cell background (not a
                // block, not the day number) starts a day-range selection.
                if (event.button !== 0) return;
                if ((event.target as HTMLElement).closest(".cal-block, .cal-grid__daynum, .cal-grid__more, button")) return;
                setCreateAnchor(iso);
                setCreateEnd(iso);
              }}
              onMouseEnter={() => {
                if (createAnchor !== null) setCreateEnd(iso);
              }}
            >
              <button
                type="button"
                className="cal-grid__daynum"
                aria-label={`Open day page ${iso}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenDayPage(iso);
                }}
              >
                {Number(iso.slice(8))}
              </button>
              <div className="cal-grid__blocks">
                {shown.map((row) => (
                  <EventBlock
                    key={row.node.id}
                    client={client}
                    nodeId={row.node.id}
                    iso={iso}
                    onOpen={() => onOpenEvent(row.node.id)}
                    onMenu={(x, y) => setBlockMenu({ x, y, nodeId: row.node.id, iso })}
                  />
                ))}
                {extra > 0 && (
                  <button
                    type="button"
                    className="cal-grid__more"
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelectDay(iso);
                    }}
                  >
                    +{extra} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {createAnchor !== null && (
        <CreationTracker
          onRelease={() => {
            if (createEnd !== null && createEnd !== createAnchor) {
              void commitCreate(createAnchor, createEnd);
            }
            setCreateAnchor(null);
            setCreateEnd(null);
          }}
        />
      )}
      {blockMenu !== null && (
        <BlockContextMenu
          menu={blockMenu}
          onOpen={onOpenEvent}
          onDelete={requestDelete}
          onCancel={() => setBlockMenu(null)}
        />
      )}
      {scopeSheet}
      <EventCreateModal
        isOpen={createAt !== null}
        onClose={() => setCreateAt(null)}
        client={client}
        startIso={createAt ?? selectedIso}
        onCreated={(nodeId) => {
          setCreateAt(null);
          onOpenEvent(nodeId);
        }}
      />
    </section>
  );
}

/** The mouse-up listener that ends a drag-create (window-level). */
function CreationTracker({ onRelease }: { onRelease: () => void }) {
  useEffect(() => {
    const release = (): void => onRelease();
    window.addEventListener("mouseup", release);
    return () => window.removeEventListener("mouseup", release);
  }, [onRelease]);
  return null;
}

/** One colored event block (the effectiveNodeColor register). */
function EventBlock({
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
  // The title register: the node's own content names the card
  // (title-is-content) — an inline class chip IS content and excerpts to
  // the class's CURRENT name (the domain helper's resolveClassName seam;
  // a chip's own displayText still wins). Only a genuinely empty flatten
  // reads the Untitled placeholder.
  const label =
    deriveDisplayName(node, (classId) => displayNameFromClient(client, classId)) ||
    untitledLabelOf(node);
  const color = client.effectiveNodeColor(node);
  // The clock prefix (owner 2026-10-24): the driving value's time on THIS
  // day — "14:30" for a timed point/range start, "14:30–16:00" for a
  // same-day range with both times; untimed blocks ride bare as before.
  const drivingRow = drivingDateRowOf(client, nodeId, iso);
  const prefix = drivingRow === undefined ? null : timePrefixOfValue(drivingRow.value);
  return (
    <button
      type="button"
      className="cal-block"
      style={color !== null ? { background: color, color: cssColorFor(color) } : undefined}
      title={prefix !== null ? `${prefix} ${label}` : label}
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
      {prefix !== null ? `${prefix} ${label}` : label}
    </button>
  );
}

/** The Year zoom: 12 compact months with event dots (Google's register). */
function YearGrid({
  client,
  year,
  selectedIso,
  todayIso,
  eventsByIsoReader,
  onOpenMonth,
  onOpenDayPage,
  onOpenYearPage,
  onCreateEvent,
}: {
  client: AnyClient;
  year: number;
  selectedIso: string;
  todayIso: string;
  eventsByIsoReader: (iso: string) => ReturnType<typeof eventRowsForDays>;
  onOpenMonth: (month0: number) => void;
  onOpenDayPage: (iso: string) => void;
  onOpenYearPage: (year: number) => void;
  /** Dblclick a day: open the event create modal at that day. */
  onCreateEvent: (iso: string) => void;
}) {
  const today = new Date();
  return (
    <section className="cal-grid cal-grid--year" aria-label="Calendar year view">
      <div className="cal-year">
        {Array.from({ length: 12 }, (_, month0) => {
          const dayCount = new Date(year, month0 + 1, 0).getDate();
          const firstWeekday = new Date(year, month0, 1).getDay();
          return (
            <div key={month0} className="cal-year__month">
              <button
                type="button"
                className={`cal-year__month-name${
                  year === Number(selectedIso.slice(0, 4)) && month0 === Number(selectedIso.slice(5, 7)) - 1
                    ? " current"
                    : ""
                }`}
                onClick={() => onOpenMonth(month0)}
              >
                {new Date(year, month0, 1).toLocaleDateString(undefined, { month: "long" })}
              </button>
              <div className="cal-year__days">
                {Array.from({ length: firstWeekday }, (_, i) => (
                  <span key={`pad-${i}`} className="cal-year__day cal-year__day--pad" aria-hidden="true" />
                ))}
                {Array.from({ length: dayCount }, (_, i) => {
                  const iso = isoLocal(year, month0, i + 1);
                  const hasEvents = eventsByIsoReader(iso).length > 0;
                  return (
                    <button
                      key={iso}
                      type="button"
                      className={`cal-year__day${
                        iso === todayIso && today.getFullYear() === year && today.getMonth() === month0
                          ? " today"
                          : ""
                      }`}
                      aria-label={`Open day page ${iso}`}
                      onClick={() => onOpenDayPage(iso)}
                      onDoubleClick={(event) => {
                        // The year zoom's days are open-page buttons: the
                        // single clicks fired first (the day page opened) —
                        // the dblclick still lands create on the day.
                        event.stopPropagation();
                        onCreateEvent(iso);
                      }}
                    >
                      {i + 1}
                      {hasEvents ? <span className="cal-year__dot" aria-hidden="true" /> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
