/**
 * calendarRows — the client-side row derivation behind every calendar/day
 * surface (the grid blocks + day agenda, the day-page sections, the
 * tasks-hub buckets). One implementation so the surfaces never drift: task
 * rows read the effective scheduled/deadline/status values (sync on both
 * client kinds — WorkerClient mirrors them through its read cache), and
 * the done-toggle is the tasks hub's exact write (property.set of the
 * status option id, never a taskClosedDate). Dated rows are the day node's
 * existing backlink set minus date-chain sources and tasks (zero model
 * work).
 */

import {
  occurrenceIsosOf,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  TASK_CLOSED_STATUSES,
  TASK_DEFAULT_STATUS,
  completedOccurrencesOf,
  dayNodeId,
  parseDateNodeId,
  recurrenceRuleOf,
  recurrenceSeriesOf,
  rendersWithDocumentChrome,
  spanEndOf,
  withCompletedOccurrence,
  type RecurrenceRule,
  type RecurrenceSeries,
} from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, ClientPropertySchema, WorkspaceClient } from "@/core/workspace-client/index.js";

import { displayNameFromClient } from "../../ui/dateDisplay.js";
import {
  isEventFamilyClass,
  minutesOfTime,
  rangeEndIsoOf,
  rangeSlotsOf,
  scheduledIsoOf,
  timeOfValue,
  type TaskBucketRow,
} from "./calendarViewUtils.js";

type AnyClient = WorkspaceClient | WorkerClient;

/** Resolve a taskStatus value (an option id) to its label; null when unset/unknown. */
export function taskStatusLabel(
  statusSchema: ClientPropertySchema | undefined,
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  return statusSchema?.options?.find((option) => option.id === value)?.label ?? value;
}

/** One task node's bucket facts: scheduled/deadline days + closed state. */
export function taskRowFacts(
  client: AnyClient,
  statusSchema: ClientPropertySchema | undefined,
  id: string,
): TaskBucketRow {
  const props = client.getEffectiveProperties(id);
  const scheduledRow = props.find(
    (prop) => prop.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskScheduled,
  );
  const scheduledIso = scheduledIsoOf(scheduledRow?.value);
  const deadlineIso = scheduledIsoOf(
    props.find((prop) => prop.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskDeadline)?.value,
  );
  const statusLabel = taskStatusLabel(
    statusSchema,
    props.find((prop) => prop.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskStatus)?.value,
  );
  return {
    id,
    scheduledIso,
    deadlineIso,
    drivingIso: null,
    closed: statusLabel !== null && TASK_CLOSED_STATUSES.has(statusLabel as "Done" | "Cancelled"),
    // Recurrence rides the taskScheduled value's metadata (null for
    // plain tasks; corrupt metadata throws — fail loud, never reads as plain).
    repeat: scheduledRow === undefined ? null : recurrenceRuleOf(scheduledRow.metadata),
    // Per-occurrence completion days (metadata.completedOccurrences;
    // [] for plain tasks — corrupt metadata throws, the fail-loud idiom).
    completedOccurrences:
      scheduledRow === undefined ? [] : completedOccurrencesOf(scheduledRow.metadata),
    occurrenceDone: false, // partitionOpenTasks sets the viewed-day flag.
  };
}

/** Bucket facts for every member of a list, in input order. */
export function taskRowsOf(
  client: AnyClient,
  statusSchema: ClientPropertySchema | undefined,
  ids: readonly string[],
): TaskBucketRow[] {
  return ids.map((id) => taskRowFacts(client, statusSchema, id));
}

/**
 * The done-toggle every task row shares. `iso` is the day the toggle
 * happened on (the day-page sections pass their viewed day).
 * viewed day).
 *
 * A PLAIN task (no recurrence rule): `property.set` of the Done/default
 * option id — exactly the tasks hub's write (no
 * taskClosedDate anywhere).
 *
 * A RECURRING task: the node-level status is never touched —
 * completing the series' status would close every occurrence at once.
 * Instead the occurrence is recorded in the taskScheduled value's metadata
 * (`completedOccurrences`, ISO dates): `iso` joins the list (done) or
 * leaves it (reopen), the value and the `repeat` rule ride through
 * untouched, and no node is materialized — occurrences stay virtual. A
 * recurring task toggled WITHOUT a day (the tasks hub's bucket toggle)
 * falls back to the status write: the hub's buckets are anchor-based and
 * its toggle means "the whole task", honestly.
 */
export async function setTaskDone(
  client: AnyClient,
  statusSchema: ClientPropertySchema | undefined,
  id: string,
  done: boolean,
  iso?: string,
): Promise<void> {
  if (iso !== undefined) {
    const scheduledRow = client
      .getEffectiveProperties(id)
      .find((entry) => entry.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskScheduled);
    const repeats = scheduledRow !== undefined && recurrenceRuleOf(scheduledRow.metadata) !== null;
    if (repeats) {
      const metadata = withCompletedOccurrence(scheduledRow!.metadata, iso, done);
      // The value re-commits verbatim (metadata-only change); PG5 multi-value
      // slots are element-addressed by idx, so a non-zero idx is preserved.
      await client.setProperty(
        id,
        SYSTEM_PROPERTY_UUIDS.taskScheduled,
        scheduledRow!.value,
        scheduledRow!.idx ?? 0,
        metadata,
      );
      return;
    }
  }
  if (statusSchema === undefined || statusSchema.options === null) return;
  const targetLabel = done ? ("Done" as const) : TASK_DEFAULT_STATUS;
  const target = statusSchema.options.find((option) => option.label === targetLabel);
  if (target === undefined) return;
  const prop = client
    .getEffectiveProperties(id)
    .find((entry) => entry.propertySchemaId === statusSchema.id);
  await client.setProperty(id, statusSchema.id, target.id, prop?.idx ?? 0);
}

/**
 * The day node's dated-reference rows: its existing backlink
 * set, deduped, minus date-chain sources (the month/year fan-in) and tasks
 * (their own section), sorted by display name. One materialized read — no
 * query.
 */
export function datedRowNodes(client: AnyClient, dayId: string): ClientNode[] {
  const seen = new Set<string>();
  const rows: ClientNode[] = [];
  for (const edge of client.getBacklinks(dayId)) {
    if (seen.has(edge.sourceId)) continue;
    seen.add(edge.sourceId);
    if (parseDateNodeId(edge.sourceId) !== null) continue;
    const node = client.getNode(edge.sourceId);
    if (node === undefined) continue;
    if (node.classIds.includes(SYSTEM_CLASS_UUIDS.task)) continue; // own section
    rows.push(node);
  }
  rows.sort(
    (a, b) =>
      (displayNameFromClient(client, a.id) ?? a.id).localeCompare(
        displayNameFromClient(client, b.id) ?? b.id,
      ) || a.id.localeCompare(b.id),
  );
  return rows;
}

// --- recurrence (compute-on-read expansion) --------------------------------------

/**
 * One recurring node: the node plus its series (rule + anchor day + the
 * recurrence exceptions — exdates/until, owner 2026-10-23) and the anchor
 * value's clock time (virtual occurrences inherit it — a 14:30 standup
 * blocks at 14:30 on every occurrence day). The rule
 * lives on a date value's metadata (`repeat`); the anchor is that value's
 * own day; occurrences derive at read time, never as nodes.
 */
export interface RecurringRow {
  node: ClientNode;
  /** The full expansion input — rule, anchor, exdates, until. */
  series: RecurrenceSeries;
  /** The anchor value's "HH:MM" (null for an untimed series). */
  time: string | null;
}

/**
 * Every recurring series in the workspace: a scan of the document-chrome
 * nodes' effective date values for an authored `repeat` (the only materialized
 * hook recurrence has — occurrences are virtual, so the month dots and the
 * day sections both start from this list). One node contributes at most one
 * series (its first repeating date value wins). Date-chain nodes are skipped;
 * a rule on a value without a day-precision anchor is ignored (the picker
 * only writes day-anchored rules); a present-but-corrupt rule, exdates, or
 * until THROWS (the series readers are fail loud — corrupt metadata never
 * reads as plain).
 */
export function recurringRowsOf(client: AnyClient): RecurringRow[] {
  const rows: RecurringRow[] = [];
  for (const node of client.listPages()) {
    if (parseDateNodeId(node.id) !== null) continue;
    for (const prop of client.getEffectiveProperties(node.id)) {
      if (prop.source !== "authored") continue;
      if (prop.schema?.type !== "datetime") continue;
      const anchorIso = scheduledIsoOf(prop.value);
      if (anchorIso === null) continue;
      const series = recurrenceSeriesOf(prop.metadata, anchorIso);
      if (series === null) continue;
      rows.push({ node, series, time: timeOfValue(prop.value) });
      break;
    }
  }
  rows.sort(
    (a, b) =>
      (displayNameFromClient(client, a.node.id) ?? a.node.id).localeCompare(
        displayNameFromClient(client, b.node.id) ?? b.node.id,
      ) || a.node.id.localeCompare(b.node.id),
  );
  return rows;
}

/** True when `iso` is an occurrence day of the full series (exceptions in). */
function seriesOccursOnDay(series: RecurrenceSeries, iso: string): boolean {
  return occurrenceIsosOf(series, iso, iso, 1).length === 1;
}

/** One event row: the node, its recurrence rule when it repeats, and its
    clock time (the driving value's start "HH:MM" — null for untimed). */
export interface DatedRow {
  node: ClientNode;
  /** The node's series rule when it repeats (started by the viewed day). */
  rule: RecurrenceRule | null;
  /** The driving value's start time — the timed-first sort key + label prefix. */
  time: string | null;
}

/**
 * The authored datetime value of `nodeId` whose day-resolution lands on
 * `iso` (a point's own day or a range's start day), if any — the value that
 * PLACED the node on this day. The block/agenda time prefix and the
 * drag-move write both read through this (one effective-properties pass).
 */
export function drivingDateRowOf(client: AnyClient, nodeId: string, iso: string) {
  return client
    .getEffectiveProperties(nodeId)
    .find(
      (prop) =>
        prop.source === "authored" &&
        prop.schema?.type === "datetime" &&
        scheduledIsoOf(prop.value) === iso,
    );
}

// --- multi-day spans (the datetime-range ruling, owner 2026-10-23) ------------

/**
 * One multi-day span: an event whose date value resolves to more than one
 * day. The canonical form is a RANGE value `{start, end}` with both slots
 * day-precision and the end after the start (the value's start slot day is
 * the inclusive start). The LEGACY register rides the value's own day plus
 * `metadata.endDate` — the drag-create path (two days before ranges shipped)
 * still lives in workspaces, so both reads stand until a migration rewrites
 * those logs; the range shape is canonical going forward.
 */
export interface SpannedRow {
  node: ClientNode;
  startIso: string;
  /** Inclusive end day. */
  endIso: string;
}

/**
 * Every multi-day event span in the workspace: the same document-chrome
 * scan recurringRowsOf runs, filtered to values whose canonical range end
 * (or legacy endDate metadata) lands after the value's own day. Corrupt
 * endDate metadata throws (fail loud).
 */
export function spannedRowsOf(client: AnyClient): SpannedRow[] {
  const rows: SpannedRow[] = [];
  for (const node of client.listPages()) {
    if (parseDateNodeId(node.id) !== null) continue;
    for (const prop of client.getEffectiveProperties(node.id)) {
      if (prop.source !== "authored") continue;
      if (prop.schema?.type !== "datetime") continue;
      const startIso = scheduledIsoOf(prop.value);
      if (startIso === null) continue;
      const endIso = rangeEndIsoOf(prop.value) ?? spanEndOf(prop.metadata);
      if (endIso === null || endIso <= startIso) continue;
      rows.push({ node, startIso, endIso });
      break;
    }
  }
  rows.sort(
    (a, b) =>
      (displayNameFromClient(client, a.node.id) ?? a.node.id).localeCompare(
        displayNameFromClient(client, b.node.id) ?? b.node.id,
      ) || a.node.id.localeCompare(b.node.id),
  );
  return rows;
}

// --- events list (the grids, the day agenda, the panel's element) ------------

/**
 * The Events-list rows for a scope of days (the grid blocks and the day
 * agenda, owner 2026-10-23/24; the journal panel's events element rides the
 * same read): event-family nodes — the
 * system `event` class and every class extending it transitively — matched
 * by EITHER family:
 *
 *  - DATED — a date-typed property value fanning into a scope day (the day
 *    node's materialized backlink set, the same read the Dated section
 *    uses, so a range end or a plain day-precision ref lands the same way);
 *  - EMBEDDED — the node lives as a block at any parent level inside one of
 *    the scope day pages (a client-side subtree walk over the scope-classed
 *    cached `getChildren`; day pages are shallow, and month scope is ~31
 *    walks).
 *
 * The recurring union rides on top (a virtual occurrence inside any scope
 * day lists the series, the Dated grammar). Tasks never list (their own
 * section), date-chain nodes neither, non-event classes neither (a node
 * that merely carries a date property stays in Dated, not here). Deduped
 * by id (dated beats embedded — one row per node).
 *
 * Each row carries its clock time — the driving value's start "HH:MM"
 * (untimed values read null) — and the sort is TIMED FIRST by start time
 * ("HH:MM" lexicographic order is chronological for the validated format),
 * then untimed alphabetically by display name (the day agenda and every
 * grid cell list their day in the Google register: an untimed event never
 * jumps a timed one).
 */
export function eventRowsForDays(
  client: AnyClient,
  isos: readonly string[],
  recurringRows: readonly RecurringRow[],
  spannedRows: readonly SpannedRow[] = [],
): DatedRow[] {
  const parentsCache = new Map<string, readonly string[]>();
  const parentsOf = (classId: string): readonly string[] => {
    let parents = parentsCache.get(classId);
    if (parents === undefined) {
      parents = client.getClassParents(classId);
      parentsCache.set(classId, parents);
    }
    return parents;
  };
  const isEventNode = (node: ClientNode): boolean =>
    node.classIds.some((classId) => isEventFamilyClass(classId, parentsOf));

  const rows = new Map<string, DatedRow>();
  const addNode = (node: ClientNode, rule: RecurrenceRule | null, time: string | null): void => {
    const existing = rows.get(node.id);
    if (existing !== undefined) {
      if (existing.rule === null && rule !== null) existing.rule = rule;
      if (existing.time === null && time !== null) existing.time = time;
      return;
    }
    rows.set(node.id, { node, rule, time });
  };
  /** The placing value's clock time on this day (null when untimed/absent). */
  const timeAt = (nodeId: string, iso: string): string | null => {
    const row = drivingDateRowOf(client, nodeId, iso);
    return row === undefined ? null : timeOfValue(row.value);
  };

  for (const iso of isos) {
    const dayId = dayNodeId(iso);
    for (const node of datedRowNodes(client, dayId)) {
      if (isEventNode(node)) addNode(node, null, timeAt(node.id, iso));
    }
    // The embedded family: every descendant of the day page (the day node
    // itself excluded — a date-chain node is never an event). The walk
    // covers blocks at ANY parent level, classes included — an
    // event-classed block nested under a plain block lists.
    if (client.getNodeRaw(dayId) !== undefined) {
      const seen = new Set<string>([dayId]);
      const queue = [dayId];
      while (queue.length > 0) {
        const current = queue.pop()!;
        for (const child of client.getChildren(current)) {
          if (seen.has(child.id)) continue;
          seen.add(child.id);
          queue.push(child.id);
          if (parseDateNodeId(child.id) !== null) continue;
          if (child.classIds.length === 0 || !isEventNode(child)) continue;
          addNode(child, null, timeAt(child.id, iso));
        }
      }
    }
    for (const entry of recurringRows) {
      if (!isEventNode(entry.node)) continue;
      if (entry.series.anchorIso <= iso && rows.has(entry.node.id)) {
        rows.get(entry.node.id)!.rule = entry.series.rule;
        continue;
      }
      if (entry.series.anchorIso > iso) continue; // series hasn't started
      if (!seriesOccursOnDay(entry.series, iso)) continue;
      addNode(entry.node, entry.series.rule, entry.time);
    }
    // The multi-day span family: the event covers every day in [start, end].
    for (const entry of spannedRows) {
      if (rows.has(entry.node.id)) continue;
      if (iso < entry.startIso || iso > entry.endIso) continue;
      if (!isEventNode(entry.node)) continue;
      addNode(entry.node, null, timeAt(entry.node.id, iso));
    }
  }

  const merged = [...rows.values()];
  merged.sort((a, b) => {
    // Timed first, chronological by the start time; untimed alphabetically.
    if (a.time !== null || b.time !== null) {
      if (a.time === null) return 1;
      if (b.time === null) return -1;
      const byTime = a.time.localeCompare(b.time);
      if (byTime !== 0) return byTime;
    }
    return (
      (displayNameFromClient(client, a.node.id) ?? a.node.id).localeCompare(
        displayNameFromClient(client, b.node.id) ?? b.node.id,
      ) || a.node.id.localeCompare(b.node.id)
    );
  });
  return merged;
}

// --- the time grid split (the Day/Week zoom, owner 2026-10-24) ---------------

/** The default timed duration: a timed point without an end = one hour (Google). */
export const TIMED_POINT_DEFAULT_MINUTES = 60;

/**
 * One timed event's placement facts for the hour grid: the start minutes
 * after midnight and the duration (a same-day range's end−start; the 1h
 * default for a timed point).
 */
export interface TimedRow {
  node: ClientNode;
  /** The node's series rule when it repeats (the recurring routing's key). */
  rule: RecurrenceRule | null;
  /** Start minutes after local midnight (0..1439). */
  startMinutes: number;
  /** Duration in minutes (positive; a same-day range reading otherwise throws). */
  durationMinutes: number;
}

/** One single-day untimed chip in the all-day band. */
export interface AllDayChip {
  node: ClientNode;
  /** The visible day's index the chip rides. */
  dayIndex: number;
}

/** One multi-day span bar, clamped to the visible window. */
export interface SpanChip {
  node: ClientNode;
  /** The span's real start day (the drag/menu register — possibly before
      the window; the bar clamps its first visible column to 0). */
  startIso: string;
  /** First visible column index the bar paints from. */
  fromIndex: number;
  /** Last visible column index (inclusive) the bar paints to. */
  toIndex: number;
}

/** The per-day split of the events read for the time grid. */
export interface TimeGridDaySplit {
  timed: TimedRow[];
  chips: AllDayChip[];
  /** The day's spans: emitted on the FIRST visible day each span covers. */
  spans: SpanChip[];
}

/**
 * The all-day-band membership + timed placement for the time grid (the
 * Google register): an event rides the all-day band when it is UNTIMED or
 * CROSSES DAYS (its range/span end lands after its day); single-day timed
 * events ride the hour grid with their start minutes + duration. `rowsForDay`
 * is the caller's `eventRowsForDays` memo over one day; `spannedRows` the
 * workspace span scan (both read-model inputs — no new scans here beyond the
 * per-row driving-value lookup).
 */
export function timeGridSplitForDays(
  client: AnyClient,
  days: readonly string[],
  rowsForDay: (iso: string) => readonly DatedRow[],
  spannedRows: readonly SpannedRow[],
): TimeGridDaySplit[] {
  const indexOf = new Map(days.map((iso, i) => [iso, i]));
  const splits: TimeGridDaySplit[] = days.map(() => ({ timed: [], chips: [], spans: [] }));

  const displayKey = (node: ClientNode): string =>
    displayNameFromClient(client, node.id) ?? node.id;
  const byName = (a: ClientNode, b: ClientNode): number =>
    displayKey(a).localeCompare(displayKey(b)) || a.id.localeCompare(b.id);

  days.forEach((iso, dayIndex) => {
    const split = splits[dayIndex]!;
    for (const row of rowsForDay(iso)) {
      // The multi-day family: the span owns the band, painted once from its
      // first visible day as a continuous bar across the covered columns.
      const span = spannedRows.find(
        (entry) =>
          entry.node.id === row.node.id &&
          entry.endIso > entry.startIso &&
          iso >= entry.startIso &&
          iso <= entry.endIso,
      );
      if (span !== undefined) {
        const startIndex = indexOf.get(span.startIso) ?? -1;
        const fromIndex = startIndex === -1 ? 0 : startIndex;
        if (dayIndex === fromIndex) {
          const endIndex = indexOf.get(span.endIso) ?? -1;
          split.spans.push({
            node: span.node,
            startIso: span.startIso,
            fromIndex,
            toIndex: endIndex === -1 ? days.length - 1 : endIndex,
          });
        }
        continue;
      }
      // Single-day: the driving value's clock time decides band vs grid
      // (a virtual recurring occurrence has no driving row — the series'
      // anchor time rides the row).
      const driving = drivingDateRowOf(client, row.node.id, iso);
      const value = driving?.value;
      const startTime = value === undefined ? row.time : timeOfValue(value);
      if (startTime === null) {
        split.chips.push({ node: row.node, dayIndex });
        continue;
      }
      const startMinutes = minutesOfTime(startTime);
      let durationMinutes = TIMED_POINT_DEFAULT_MINUTES;
      if (value !== undefined && rangeEndIsoOf(value) === iso) {
        // A same-day timed range: the duration is the end−start; an end at
        // or before the start is malformed — fail loud.
        const endTime = rangeSlotsOf(value)?.end?.time;
        if (endTime !== null && endTime !== undefined) {
          const endMinutes = minutesOfTime(endTime);
          if (endMinutes <= startMinutes) {
            throw new Error(
              `Same-day range ends before it starts on ${iso} (${startTime}–${endTime}).`,
            );
          }
          durationMinutes = endMinutes - startMinutes;
        }
      }
      split.timed.push({ node: row.node, rule: row.rule, startMinutes, durationMinutes });
    }
    split.timed.sort(
      (a, b) => a.startMinutes - b.startMinutes || byName(a.node, b.node),
    );
    split.chips.sort((a, b) => byName(a.node, b.node));
    split.spans.sort((a, b) => a.fromIndex - b.fromIndex || byName(a.node, b.node));
  });
  return splits;
}

/**
 * The Agenda zoom's per-row time label (the Google multi-day register):
 * a single-day timed point reads its start ("09:00"), a same-day timed
 * range the span ("09:00 – 10:00"), an untimed event "All day"; a multi-day
 * span reads its START TIME on the first day ("15:00"), "All day" on the
 * middle days, and "Until 18:00" (the end time) on the last. The driving
 * value lookup is per (node, day); a virtual recurring occurrence falls back
 * to the series' anchor time.
 */
export function agendaTimeLabelOf(
  client: AnyClient,
  row: DatedRow,
  iso: string,
  spannedRows: readonly SpannedRow[],
): string {
  const driving = drivingDateRowOf(client, row.node.id, iso);
  const span = spannedRows.find(
    (entry) =>
      entry.node.id === row.node.id &&
      entry.endIso > entry.startIso &&
      iso >= entry.startIso &&
      iso <= entry.endIso,
  );
  if (span !== undefined) {
    if (driving !== undefined) {
      const startTime = timeOfValue(driving.value);
      return startTime ?? "All day";
    }
    if (iso === span.endIso) {
      const startRow = drivingDateRowOf(client, row.node.id, span.startIso);
      const endTime =
        startRow === undefined ? null : (rangeSlotsOf(startRow.value)?.end?.time ?? null);
      return endTime !== null ? `Until ${endTime}` : "All day";
    }
    return "All day";
  }
  if (driving === undefined) return row.time ?? "All day";
  const startTime = timeOfValue(driving.value);
  if (startTime === null) return "All day";
  const endTime =
    rangeEndIsoOf(driving.value) === iso
      ? (rangeSlotsOf(driving.value)?.end?.time ?? null)
      : null;
  return endTime !== null ? `${startTime} – ${endTime}` : startTime;
}

/**
 * The containing page for the group-by-page key — referenceEntry's walk,
 * client-side: the nearest ancestor rendering with document chrome (the
 * node itself when it already matches; the parent-page condition rides
 * along, owner ruling 2026-10-15). A dated standalone event groups under
 * itself (the collection's standalone path); an embedded block groups
 * under its day page.
 */
export function containingPageIdOf(client: AnyClient, node: ClientNode): string {
  let current = node;
  for (let guard = 0; guard < 64; guard += 1) {
    if (current.parentId === null) break;
    const parent = client.getNode(current.parentId);
    // The parent-page condition rides along: a bit under a non-page parent
    // is inert, so the walk continues past it to the real containing page.
    if (parent === undefined || rendersWithDocumentChrome(current, parent)) break;
    current = parent;
  }
  return current.id;
}
