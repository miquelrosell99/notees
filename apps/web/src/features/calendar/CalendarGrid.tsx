/**
 * CalendarGrid — the calendar's zoom-ladder grids (owner 2026-10-23, the
 * google-calendar proposal slice 2): the Week / Month / Year zooms of the
 * Calendar view, each rendering the events list's exact membership
 * (calendarRows.eventRowsForDays — event-family nodes dated into the day
 * or embedded in the day page) as COLORED BLOCKS (effectiveNodeColor: own
 * color, else the first class's). Day zoom stays the existing day view
 * (CalendarView renders it); this component owns the other three.
 *
 * The whole-day register (the dates law): blocks are single-day — a
 * datetime value is one day; multi-day spans are a deferred datetime-range
 * ruling, so a multi-day event is N date values or N blocks, never a
 * painted span.
 *
 * Interactions (the Google register): a block click opens the event; the
 * day-number opens the day PAGE (owner ruling 2026-10-23); clicking
 * elsewhere in a cell selects the day; month cells cap the visible blocks
 * (BLOCKS_PER_CELL) with an honest "+N" that jumps to the day zoom. Period
 * navigation (prev/next) steps the VISIBLE window without moving the
 * selection; the window follows the selection when it drifts across a
 * boundary (the MonthCalendar contract). Drag-and-drop (move/create) and
 * the recurring scope dialog are the next slices — this grid renders their
 * drop targets already via the cell data attributes.
 */

import { useEffect, useMemo, useState } from "react";

import { Button } from "../../components/ui/fleet/Button.js";
import { cssColorFor } from "../../components/ui/fleet/colorPresets.js";
import { displayNameFromClient } from "../../ui/dateDisplay.js";
import type { AnyClient } from "../../ui/app/Sidebar.js";
import { eventRowsForDays, type RecurringRow } from "./calendarRows.js";
import {
  deleteOccurrence,
  editOccurrence,
  type RecurrenceScope,
} from "./calendarRecurrence.js";
import { dayNodeId, recurrenceRuleOf, SYSTEM_CLASS_UUIDS } from "@notees/domain";
import { isoLocal, useWeekdayHeader } from "./dayGrid.js";
import { addDaysIso, scheduledIsoOf, weekDaysOfIso } from "./calendarViewUtils.js";
import "./CalendarGrid.css";

/** Blocks a month cell shows before the honest "+N" row. */
const BLOCKS_PER_CELL = 3;

export type GridZoom = "week" | "month" | "year";

export interface CalendarGridProps {
  client: AnyClient;
  zoom: GridZoom;
  /** The selected day (local YYYY-MM-DD) — outlined, anchors the week zoom. */
  selectedIso: string;
  firstDayOfWeek: number;
  /** The recurring series scan (the caller's memo — the read model input). */
  recurringRows: readonly RecurringRow[];
  /** Day pick: select the day (a cell click; the "+N" row jumps with it). */
  onSelectDay: (iso: string) => void;
  /** Block click: open the event node. */
  onOpenEvent: (nodeId: string) => void;
  /** The day-number register: open the day's page (chain ensured by the host). */
  onOpenDayPage: (iso: string) => void;
  /** Year zoom: open a month (the host switches the zoom + selects its first day). */
  onOpenMonth: (year: number, month0: number) => void;
}

/** The visible-period window, owned by the grid (navigation stays local). */
interface VisiblePeriod {
  year: number;
  month0: number;
}

function periodOf(iso: string): VisiblePeriod {
  const [y, m] = iso.split("-").map(Number);
  return { year: y!, month0: m! - 1 };
}

function shiftMonth(period: VisiblePeriod, delta: number): VisiblePeriod {
  const total = period.year * 12 + period.month0 + delta;
  return { year: Math.floor(total / 12), month0: total % 12 };
}

export function CalendarGrid({
  client,
  zoom,
  selectedIso,
  firstDayOfWeek,
  recurringRows,
  onSelectDay,
  onOpenEvent,
  onOpenDayPage,
  onOpenMonth,
}: CalendarGridProps) {
  const [period, setPeriod] = useState<VisiblePeriod>(() => periodOf(selectedIso));
  /** The recurring scope dialog's pending action (a move or a delete). */
  const [pendingAction, setPendingAction] = useState<
    | { kind: "move"; nodeId: string; fromIso: string; toIso: string }
    | { kind: "delete"; nodeId: string; iso: string }
    | null
  >(null);
  /** The block context menu (right-click), fixed-position. */
  const [blockMenu, setBlockMenu] = useState<{ x: number; y: number; nodeId: string; iso: string } | null>(null);
  /** Drag-create anchor: the day the press started on (null = not creating). */
  const [createAnchor, setCreateAnchor] = useState<string | null>(null);
  const [createEnd, setCreateEnd] = useState<string | null>(null);
  // The visible window follows the selection when it drifts across a
  // boundary (prev/next day, an open from another surface) — the
  // MonthCalendar contract.
  useEffect(() => {
    const next = periodOf(selectedIso);
    if (zoom === "month" && (next.year !== period.year || next.month0 !== period.month0)) {
      setPeriod(next);
    }
    if (zoom === "year" && next.year !== period.year) setPeriod(next);
    if (zoom === "week") setPeriod(next); // the week zoom always tracks the day
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follow the selection only
  }, [selectedIso, zoom]);

  const weekdayHeader = useWeekdayHeader(firstDayOfWeek);
  const todayIso = (() => {
    const now = new Date();
    return isoLocal(now.getFullYear(), now.getMonth(), now.getDate());
  })();

  // The rendered day cells + the events read per cell. Month shows the
  // whole visible month plus lead/trail days of the neighbors (Google's
  // register: neighbor days render dimmed); week shows exactly the visible
  // week; the year zoom renders its own compact months.
  const cells = useMemo(() => {
    if (zoom === "week") return weekDaysOfIso(selectedIso, firstDayOfWeek);
    if (zoom === "month") {
      const lead = (new Date(period.year, period.month0, 1).getDay() - firstDayOfWeek + 7) % 7;
      const dayCount = new Date(period.year, period.month0 + 1, 0).getDate();
      const total = lead + dayCount;
      const trail = (7 - (total % 7)) % 7;
      const from = addDaysIso(isoLocal(period.year, period.month0, 1), -lead);
      return Array.from({ length: total + trail }, (_, i) => addDaysIso(from, i));
    }
    return [];
  }, [zoom, selectedIso, firstDayOfWeek, period]);

  const eventsByIso = useMemo(() => {
    const map = new Map<string, ReturnType<typeof eventRowsForDays>>();
    for (const iso of cells) map.set(iso, eventRowsForDays(client, [iso], recurringRows));
    return map;
  }, [client, cells, recurringRows]);

  // --- the drag-and-drop writes (owner 2026-10-23, google-calendar slice 3) --

  /** The authored datetime value of `nodeId` anchored at `iso`, if any. */
  const dateRowAt = (nodeId: string, iso: string) =>
    client
      .getEffectiveProperties(nodeId)
      .find(
        (prop) =>
          prop.source === "authored" &&
          prop.schema?.type === "datetime" &&
          scheduledIsoOf(prop.value) === iso,
      );

  const isRecurringAt = (nodeId: string, iso: string): boolean => {
    const row = dateRowAt(nodeId, iso);
    return row !== undefined && recurrenceRuleOf(row.metadata) !== null;
  };

  /** A block dropped on another day: plain events rewrite the date; recurring
      events route through the scope dialog (slice 4). */
  const moveEvent = (nodeId: string, fromIso: string, toIso: string): void => {
    if (fromIso === toIso) return;
    if (isRecurringAt(nodeId, fromIso)) {
      setPendingAction({ kind: "move", nodeId, fromIso, toIso });
      return;
    }
    const row = dateRowAt(nodeId, fromIso);
    if (row === undefined) return;
    void client.ensureDateChain(toIso).then(async () => {
      await client.setProperty(
        nodeId,
        row.propertySchemaId,
        { nodeId: dayNodeId(toIso) },
        row.idx ?? 0,
        row.metadata ?? undefined,
      );
    });
  };

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
      for (let idx = 0; idx < days.length; idx += 1) {
        await client.setProperty(id, schemaId, { nodeId: dayNodeId(days[idx]!) }, idx);
      }
    }
    onSelectDay(a);
    onOpenEvent(id);
  };

  /** The context-menu delete: recurring events route through the scope dialog. */
  const requestDelete = (nodeId: string, iso: string): void => {
    setBlockMenu(null);
    if (isRecurringAt(nodeId, iso)) {
      setPendingAction({ kind: "delete", nodeId, iso });
      return;
    }
    void deleteOccurrence(client, nodeId, iso, "all");
  };

  if (zoom === "year") {
    return (
      <YearGrid
        client={client}
        year={period.year}
        selectedIso={selectedIso}
        todayIso={todayIso}
        eventsByIsoReader={(iso) => eventRowsForDays(client, [iso], recurringRows)}
        onPrev={() => setPeriod((p) => ({ ...p, year: p.year - 1 }))}
        onNext={() => setPeriod((p) => ({ ...p, year: p.year + 1 }))}
        onOpenMonth={(month0) => onOpenMonth(period.year, month0)}
        onOpenDayPage={onOpenDayPage}
      />
    );
  }

  const periodLabel =
    zoom === "week"
      ? (() => {
          const [a, b] = [cells[0], cells[cells.length - 1]];
          const fmt = (iso: string) =>
            new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            });
          return a && b ? `${fmt(a)} – ${fmt(b)}` : "";
        })()
      : new Date(period.year, period.month0, 1).toLocaleDateString(undefined, {
          month: "long",
          year: "numeric",
        });

  return (
    <section className="cal-grid" aria-label={`Calendar ${zoom} view`}>
      <div className="cal-grid__header">
        <Button
          variant="ghost"
          size="sm"
          icon="mdi-chevron-left"
          aria-label="Previous period"
          onClick={() =>
            zoom === "week" ? onSelectDay(addDaysIso(selectedIso, -7)) : setPeriod((p) => shiftMonth(p, -1))
          }
        />
        <h2 className="cal-grid__title">{periodLabel}</h2>
        <Button
          variant="ghost"
          size="sm"
          icon="mdi-chevron-right"
          aria-label="Next period"
          onClick={() =>
            zoom === "week" ? onSelectDay(addDaysIso(selectedIso, 7)) : setPeriod((p) => shiftMonth(p, 1))
          }
        />
      </div>
      <div className="cal-grid__weekdays">
        {weekdayHeader.map((name, i) => (
          <span key={`${name}-${i}`} className="cal-grid__weekday">
            {name}
          </span>
        ))}
      </div>
      <div className={`cal-grid__cells${zoom === "week" ? " cal-grid__cells--week" : ""}`}>
        {cells.map((iso) => {
          const inMonth =
            zoom === "week" ||
            Number(iso.slice(5, 7)) === period.month0 + 1;
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
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const payload = event.dataTransfer.getData("text/x-notees-event");
                if (payload === "") return;
                const [nodeId, fromIso] = payload.split("|");
                if (nodeId !== undefined && fromIso !== undefined) moveEvent(nodeId, fromIso, iso);
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
        <div
          className="cal-block-menu"
          style={{ left: blockMenu.x, top: blockMenu.y }}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onOpenEvent(blockMenu.nodeId);
              setBlockMenu(null);
            }}
          >
            Open event
          </button>
          <button
            type="button"
            role="menuitem"
            className="cal-block-menu__danger"
            onClick={() => requestDelete(blockMenu.nodeId, blockMenu.iso)}
          >
            Delete
          </button>
          <button type="button" role="menuitem" onClick={() => setBlockMenu(null)}>
            Cancel
          </button>
        </div>
      )}
      {pendingAction !== null && (
        <RecurrenceScopeSheet
          action={pendingAction}
          onCancel={() => setPendingAction(null)}
          onPick={(scope) => {
            const action = pendingAction;
            setPendingAction(null);
            if (action.kind === "move") {
              void editOccurrence(client, action.nodeId, action.fromIso, scope, {
                toIso: action.toIso,
              });
            } else {
              void deleteOccurrence(client, action.nodeId, action.iso, scope);
            }
          }}
        />
      )}
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
  const label = displayNameFromClient(client, nodeId) ?? "Untitled";
  const color = client.effectiveNodeColor(node);
  return (
    <button
      type="button"
      className="cal-block"
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

/**
 * The recurring scope sheet (owner 2026-10-23, slice 4): the Google
 * register — Only this event / This and following events / All events —
 * asked when a recurring event is moved or deleted.
 */
function RecurrenceScopeSheet({
  action,
  onCancel,
  onPick,
}: {
  action: { kind: "move"; nodeId: string; fromIso: string; toIso: string } | { kind: "delete"; nodeId: string; iso: string };
  onCancel: () => void;
  onPick: (scope: RecurrenceScope) => void;
}) {
  const [scope, setScope] = useState<RecurrenceScope>("one");
  const dayLabel = (iso: string) =>
    new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  const occurrenceIso = action.kind === "move" ? action.fromIso : action.iso;
  const verb = action.kind === "move" ? "move" : "delete";
  const options: Array<{ value: RecurrenceScope; label: string; hint: string }> = [
    {
      value: "one",
      label: "Only this event",
      hint:
        action.kind === "move"
          ? `${dayLabel(occurrenceIso)} detaches into its own event on ${dayLabel(action.toIso)}.`
          : `Only ${dayLabel(occurrenceIso)} is removed.`,
    },
    {
      value: "following",
      label: "This and following events",
      hint:
        action.kind === "move"
          ? `The series splits at ${dayLabel(occurrenceIso)}; the moved event carries forward.`
          : `The series ends before ${dayLabel(occurrenceIso)}.`,
    },
    {
      value: "all",
      label: "All events",
      hint: "The whole series, past and future.",
    },
  ];
  return (
    <div className="cal-scope" role="dialog" aria-modal="true" aria-label="Recurring event">
      <div className="cal-scope__card">
        <h3 className="cal-scope__title">
          {action.kind === "move" ? "Move recurring event" : "Delete recurring event"}
        </h3>
        <p className="cal-scope__body">
          This is a recurring event. Which events do you want to {verb}?
        </p>
        <div className="cal-scope__options" role="radiogroup" aria-label="Scope">
          {options.map((option) => (
            <label key={option.value} className="cal-scope__option">
              <input
                type="radio"
                name="recurrence-scope"
                value={option.value}
                checked={scope === option.value}
                onChange={() => setScope(option.value)}
              />
              <span className="cal-scope__option-text">
                <span className="cal-scope__option-label">{option.label}</span>
                <span className="cal-scope__option-hint">{option.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="cal-scope__actions">
          <button type="button" className="cal-scope__btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="cal-scope__btn cal-scope__btn--primary"
            onClick={() => onPick(scope)}
          >
            {action.kind === "move" ? "Move" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The Year zoom: 12 compact months with event dots (Google's register). */
function YearGrid({
  client,
  year,
  selectedIso,
  todayIso,
  eventsByIsoReader,
  onPrev,
  onNext,
  onOpenMonth,
  onOpenDayPage,
}: {
  client: AnyClient;
  year: number;
  selectedIso: string;
  todayIso: string;
  eventsByIsoReader: (iso: string) => ReturnType<typeof eventRowsForDays>;
  onPrev: () => void;
  onNext: () => void;
  onOpenMonth: (month0: number) => void;
  onOpenDayPage: (iso: string) => void;
}) {
  const today = new Date();
  return (
    <section className="cal-grid cal-grid--year" aria-label="Calendar year view">
      <div className="cal-grid__header">
        <Button variant="ghost" size="sm" icon="mdi-chevron-left" aria-label="Previous period" onClick={onPrev} />
        <h2 className="cal-grid__title">{year}</h2>
        <Button variant="ghost" size="sm" icon="mdi-chevron-right" aria-label="Next period" onClick={onNext} />
      </div>
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
