/**
 * taskReminders — the pure logic behind in-app task reminders (the Google
 * Tasks model): a task's reminder rides its OWN Scheduled (else Deadline)
 * datetime — a timed value fires at its clock time, an all-day value fires
 * at the device-local default time (Settings → Tasks, 09:00 out of the box).
 * No new property, no wire state: the moment derives from ordinary LWW
 * property values every client already mirrors.
 *
 * Firing rules (all pinned by test):
 *  - Closed tasks (Done/Cancelled) never remind.
 *  - A RECURRING task reminds on each occurrence day (today's occurrence
 *    only — a completed occurrence never reminds, and a missed one rolls
 *    forward with the series, the calendar law).
 *  - A missed moment catches up ONLY within its own local day (open the app
 *    at 14:00, the 09:00 reminder still fires); a moment from a PAST day
 *    never fires — the Review queue owns slipped work.
 *  - Fired-state is device-local ("device state is never an op"): one fire
 *    per task-moment per device, persisted under `notees.reminders.fired`
 *    and pruned to the trailing two days.
 *
 * Everything here is pure — the App-level `useTaskReminders` hook owns the
 * timers, the toast, and the browser Notification.
 */

import type { RecurrenceRule } from "@notees/domain";

import { occursOnDay, timeOfValue } from "./calendarViewUtils.js";

/** The all-day default when the device setting is absent or malformed. */
export const DEFAULT_ALL_DAY_REMINDER_TIME = "09:00";

const FIRED_STORAGE_KEY = "notees.reminders.fired";

/** One task's computed reminder moment (local day + wall-clock time). */
export interface TaskReminderMoment {
  taskId: string;
  /** Which property drives the reminder (Scheduled wins over Deadline). */
  kind: "scheduled" | "deadline";
  /** Local ISO day the reminder fires on. */
  dayIso: string;
  /** "HH:MM" 24h — the value's own clock time, or the all-day default. */
  time: string;
  /** True when `time` came from the all-day default (the toast copy says so). */
  allDay: boolean;
}

/** "HH:MM" 24h, 00:00–23:59. */
export function isValidTimeOfDay(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** The device-local fire timestamp (ms) of a moment. */
export function reminderFireMs(moment: Pick<TaskReminderMoment, "dayIso" | "time">): number {
  const [year, month, day] = moment.dayIso.split("-").map(Number);
  const [hours, minutes] = moment.time.split(":").map(Number);
  return new Date(year!, month! - 1, day!, hours!, minutes!, 0, 0).getTime();
}

/** The fired-state key: one fire per task-moment per device. */
export function reminderKeyOf(moment: Pick<TaskReminderMoment, "taskId" | "dayIso" | "time">): string {
  return `${moment.taskId}@${moment.dayIso}T${moment.time}`;
}

/** One task's reminder input, read off the client by the hook. */
export interface TaskReminderFacts {
  taskId: string;
  closed: boolean;
  /** The raw taskScheduled / taskDeadline property values (null when unset). */
  scheduledValue: unknown;
  deadlineValue: unknown;
  /** The day the scheduled VALUE anchors (its slot's ISO day), null when unset. */
  scheduledIso: string | null;
  /** The day the deadline VALUE anchors, null when unset. */
  deadlineIso: string | null;
  repeat: RecurrenceRule | null;
  completedOccurrences: readonly string[];
}

/**
 * One task's reminder moment, or null when it never reminds: closed, no
 * scheduled/deadline day at all, a recurring task whose today is not an
 * open occurrence, or a past-day moment (the same-day catch-up window is
 * the caller's `todayIso` — moments derive for today or the future only).
 */
export function taskReminderMomentOf(
  facts: TaskReminderFacts,
  todayIso: string,
  allDayTime: string,
): TaskReminderMoment | null {
  if (facts.closed) return null;
  const fallback = isValidTimeOfDay(allDayTime) ? allDayTime : DEFAULT_ALL_DAY_REMINDER_TIME;
  const driving =
    facts.scheduledIso !== null
      ? ({ kind: "scheduled", iso: facts.scheduledIso, value: facts.scheduledValue } as const)
      : facts.deadlineIso !== null
        ? ({ kind: "deadline", iso: facts.deadlineIso, value: facts.deadlineValue } as const)
        : null;
  if (driving === null) return null;

  let dayIso: string;
  if (facts.repeat !== null) {
    // Recurring: remind on TODAY's occurrence only — a completed occurrence
    // stays silent, a missed one rolls forward with the series, and a future
    // occurrence re-derives when its day arrives.
    if (facts.scheduledIso === null) return null; // a series anchors on Scheduled
    if (!occursOnDay(facts.repeat, facts.scheduledIso, todayIso)) return null;
    if (facts.completedOccurrences.includes(todayIso)) return null;
    dayIso = todayIso;
  } else {
    if (driving.iso < todayIso) return null; // past days never fire (the Review queue owns them)
    dayIso = driving.iso;
  }

  const time = timeOfValue(driving.value);
  return {
    taskId: facts.taskId,
    kind: driving.kind,
    dayIso,
    time: time !== null && isValidTimeOfDay(time) ? time : fallback,
    allDay: time === null,
  };
}

// --- fired-state (device-local, pruned) -------------------------------------------

interface FiredEntry {
  key: string;
  firedAtMs: number;
}

/** The stored fired entries, pruned to the trailing two local days. */
export function readFiredReminders(nowMs: number): FiredEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(window.localStorage.getItem(FIRED_STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const cutoff = nowMs - 2 * 24 * 60 * 60 * 1000;
  return raw.filter(
    (entry): entry is FiredEntry =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as FiredEntry).key === "string" &&
      typeof (entry as FiredEntry).firedAtMs === "number" &&
      (entry as FiredEntry).firedAtMs >= cutoff,
  );
}

/** Record one fired moment (pruning the store in the same write). */
export function markReminderFired(key: string, nowMs: number): void {
  const entries = readFiredReminders(nowMs).filter((entry) => entry.key !== key);
  entries.push({ key, firedAtMs: nowMs });
  window.localStorage.setItem(FIRED_STORAGE_KEY, JSON.stringify(entries));
}

// --- the scheduling read ------------------------------------------------------------

/**
 * The moments due at `nowMs`: fire time reached, not yet fired on this
 * device, and still inside the same-day catch-up window (a moment whose
 * local DAY is past never fires — the Review queue owns slipped work).
 */
export function dueReminders(
  moments: readonly TaskReminderMoment[],
  nowMs: number,
  firedKeys: ReadonlySet<string>,
  todayIso: string,
): TaskReminderMoment[] {
  return moments
    .filter(
      (moment) =>
        moment.dayIso >= todayIso &&
        reminderFireMs(moment) <= nowMs &&
        !firedKeys.has(reminderKeyOf(moment)),
    )
    .sort((a, b) => reminderFireMs(a) - reminderFireMs(b));
}

/**
 * Ms until the earliest unfired FUTURE moment (the timer arm), or null when
 * nothing is pending. Capped by the caller if needed — a re-derivation on
 * any client notify re-arms anyway.
 */
export function nextReminderDelay(
  moments: readonly TaskReminderMoment[],
  nowMs: number,
  firedKeys: ReadonlySet<string>,
): number | null {
  let next: number | null = null;
  for (const moment of moments) {
    if (firedKeys.has(reminderKeyOf(moment))) continue;
    const fireMs = reminderFireMs(moment);
    if (fireMs <= nowMs) continue;
    if (next === null || fireMs < next) next = fireMs;
  }
  return next === null ? null : next - nowMs;
}
