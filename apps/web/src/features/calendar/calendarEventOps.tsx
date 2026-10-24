/**
 * calendarEventOps — the shared event operations behind every calendar
 * surface (the Month/Year grid blocks and the Day/Week time grid): the
 * block drag-move (a day move preserves the value's time-of-day and shifts
 * a range's slots by the dragged delta; a timed drop also re-anchors the
 * start time, preserving the duration), the right-click context menu, and
 * the recurring scope routing (a recurring event's move/delete asks the
 * Google register — Only this event / This and following / All). One
 * implementation so the surfaces never drift.
 */

import { useState, type ReactElement } from "react";

import { dayNodeId, parseDateNodeId, recurrenceRuleOf } from "@notees/domain";

import type { AnyClient } from "../../ui/app/Sidebar.js";
import { drivingDateRowOf } from "./calendarRows.js";
import {
  addDaysIso,
  daysBetweenIsos,
  isoOfDateParts,
  minutesOfTime,
  rangeSlotsOf,
  timeOfMinutes,
  type DateValueSlot,
} from "./calendarViewUtils.js";
import {
  deleteOccurrence,
  editOccurrence,
  type RecurrenceScope,
} from "./calendarRecurrence.js";

/** The fixed-position block context menu's state. */
export interface BlockMenuState {
  x: number;
  y: number;
  nodeId: string;
  iso: string;
}

export type PendingAction =
  | { kind: "move"; nodeId: string; fromIso: string; toIso: string }
  | { kind: "delete"; nodeId: string; iso: string };

/** The local ISO day of a range slot (null unless day precision). */
function isoOfSlot(slot: DateValueSlot | null): string | null {
  if (slot === null) return null;
  const parsed = parseDateNodeId(slot.nodeId);
  return parsed !== null && parsed.precision === "day" ? isoOfDateParts(parsed) : null;
}

/** A point value's slot (the range readers' point branch). */
function pointOf(value: unknown): DateValueSlot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const nodeId = (value as { nodeId?: unknown }).nodeId;
  if (typeof nodeId !== "string") return null;
  const time = (value as { time?: unknown }).time;
  return { nodeId, time: typeof time === "string" ? time : null };
}

/** One shifted slot: the day moves by `delta`, the time-of-day rides along. */
function slotShiftedBy(slot: DateValueSlot, slotIso: string, delta: number): { nodeId: string; time?: string } {
  const next: { nodeId: string; time?: string } = { nodeId: dayNodeId(addDaysIso(slotIso, delta)) };
  if (slot.time !== null) next.time = slot.time;
  return next;
}

export function useEventOps(client: AnyClient): {
  /** The right-click menu state (fixed position). */
  menu: BlockMenuState | null;
  setMenu: (menu: BlockMenuState | null) => void;
  /** The recurring scope sheet's pending action (null = closed). */
  pendingAction: PendingAction | null;
  /** A block dropped on another DAY: rewrite the day, preserving the
      time-of-day; a range's slots shift by the dragged delta. */
  moveEventToDay: (nodeId: string, fromIso: string, toIso: string) => void;
  /** A timed block dropped on a day column AT AN HOUR: re-anchor the start
      time, preserving the duration. */
  moveEventToTime: (nodeId: string, fromIso: string, toIso: string, startMinutes: number) => void;
  /** The context-menu delete (recurring routes through the scope sheet). */
  requestDelete: (nodeId: string, iso: string) => void;
  /** The rendered scope sheet element (null when no action is pending). */
  scopeSheet: ReactElement | null;
} {
  const [menu, setMenu] = useState<BlockMenuState | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);

  /** The authored datetime value of `nodeId` anchored at `iso`, if any. */
  const dateRowAt = (nodeId: string, iso: string) => drivingDateRowOf(client, nodeId, iso);

  const isRecurringAt = (nodeId: string, iso: string): boolean => {
    const row = dateRowAt(nodeId, iso);
    return row !== undefined && recurrenceRuleOf(row.metadata) !== null;
  };

  const writeMoved = (
    nodeId: string,
    row: NonNullable<ReturnType<typeof drivingDateRowOf>>,
    toIso: string,
    nextValue: unknown,
  ): void => {
    void client.ensureDateChain(toIso).then(async () => {
      await client.setProperty(
        nodeId,
        row.propertySchemaId,
        nextValue,
        row.idx ?? 0,
        row.metadata ?? undefined,
      );
    });
  };

  const moveEventToDay = (nodeId: string, fromIso: string, toIso: string): void => {
    if (fromIso === toIso) return;
    if (isRecurringAt(nodeId, fromIso)) {
      setPendingAction({ kind: "move", nodeId, fromIso, toIso });
      return;
    }
    const row = dateRowAt(nodeId, fromIso);
    if (row === undefined) return;
    const value = row.value;
    const range = rangeSlotsOf(value);
    let nextValue: unknown;
    if (range === null) {
      const point = pointOf(value);
      const base: { nodeId: string; time?: string } = { nodeId: dayNodeId(toIso) };
      if (point !== null && point.time !== null) {
        base.time = point.time;
      }
      nextValue = base;
    } else {
      const delta = daysBetweenIsos(fromIso, toIso);
      const next: Record<string, unknown> = {};
      if (range.start !== null) {
        next.start = slotShiftedBy(range.start, isoOfSlot(range.start) ?? fromIso, delta);
      }
      if (range.end !== null) {
        next.end = slotShiftedBy(range.end, isoOfSlot(range.end) ?? fromIso, delta);
      }
      nextValue = next;
    }
    writeMoved(nodeId, row, toIso, nextValue);
  };

  const moveEventToTime = (
    nodeId: string,
    fromIso: string,
    toIso: string,
    startMinutes: number,
  ): void => {
    if (isRecurringAt(nodeId, fromIso)) {
      // The scope dialog owns the recurring write (a detach copies the value
      // to the new day; the chosen hour is its day-anchored best effort).
      setPendingAction({ kind: "move", nodeId, fromIso, toIso });
      return;
    }
    const row = dateRowAt(nodeId, fromIso);
    if (row === undefined) return;
    const range = rangeSlotsOf(row.value);
    if (
      range === null ||
      range.start === null ||
      (isoOfSlot(range.end) !== null &&
        isoOfSlot(range.end) !== isoOfSlot(range.start))
    ) {
      // A point or a cross-day range: the day move preserves the shape.
      moveEventToDay(nodeId, fromIso, toIso);
      return;
    }
    // A same-day timed range: re-anchor the start, preserve the duration.
    const startTime = range.start.time;
    const endTime = range.end?.time ?? null;
    let duration = 60;
    if (startTime !== null && endTime !== null) {
      duration = minutesOfTime(endTime) - minutesOfTime(startTime);
      if (duration <= 0) duration = 60;
    }
    const startSlot = { nodeId: dayNodeId(toIso), time: timeOfMinutes(startMinutes) };
    const endSlot =
      range.end === null
        ? null
        : { nodeId: dayNodeId(toIso), time: timeOfMinutes(startMinutes + duration) };
    const nextValue =
      endSlot === null
        ? startTime === null
          ? { nodeId: dayNodeId(toIso) }
          : startSlot
        : { start: startSlot, end: endSlot };
    writeMoved(nodeId, row, toIso, nextValue);
  };

  const requestDelete = (nodeId: string, iso: string): void => {
    setMenu(null);
    if (isRecurringAt(nodeId, iso)) {
      setPendingAction({ kind: "delete", nodeId, iso });
      return;
    }
    void deleteOccurrence(client, nodeId, iso, "all");
  };

  const scopeSheet =
    pendingAction !== null ? (
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
    ) : null;

  return {
    menu,
    setMenu,
    pendingAction,
    moveEventToDay,
    moveEventToTime,
    requestDelete,
    scopeSheet,
  };
}

/** The right-click block menu (Open / Delete / Cancel), fixed-position. */
export function BlockContextMenu({
  menu,
  onOpen,
  onDelete,
  onCancel,
}: {
  menu: BlockMenuState;
  onOpen: (nodeId: string) => void;
  onDelete: (nodeId: string, iso: string) => void;
  onCancel: () => void;
}) {
  return (
    <div className="cal-block-menu" style={{ left: menu.x, top: menu.y }} role="menu">
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onOpen(menu.nodeId);
          onCancel();
        }}
      >
        Open event
      </button>
      <button
        type="button"
        role="menuitem"
        className="cal-block-menu__danger"
        onClick={() => onDelete(menu.nodeId, menu.iso)}
      >
        Delete
      </button>
      <button type="button" role="menuitem" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/**
 * The recurring scope sheet (owner 2026-10-23, slice 4): the Google
 * register — Only this event / This and following events / All events —
 * asked when a recurring event is moved or deleted.
 */
export function RecurrenceScopeSheet({
  action,
  onCancel,
  onPick,
}: {
  action: PendingAction;
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
