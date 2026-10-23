/**
 * calendarRows — the client-side row derivation behind every calendar/day
 * surface (the Calendar day view, the day-page sections, the tasks-hub
 * buckets). One implementation so the three never drift: task rows read the
 * effective scheduled/deadline/status values (sync on both client kinds —
 * WorkerClient mirrors them through its read cache), and the done-toggle is
 * the tasks hub's exact write (property.set of the status option id, never
 * a taskClosedDate). Dated rows are the day node's existing backlink set
 * minus date-chain sources and tasks (zero model work).
 */

import {
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  TASK_CLOSED_STATUSES,
  TASK_DEFAULT_STATUS,
  completedOccurrencesOf,
  dayNodeId,
  parseDateNodeId,
  recurrenceRuleOf,
  rendersWithDocumentChrome,
  withCompletedOccurrence,
  type RecurrenceRule,
} from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, ClientPropertySchema, WorkspaceClient } from "@/core/workspace-client/index.js";

import { displayNameFromClient } from "../../ui/dateDisplay.js";
import { isEventFamilyClass, occursOnDay, scheduledIsoOf, type TaskBucketRow } from "./calendarViewUtils.js";

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
 * happened on (the Calendar day view and the day-page sections pass their
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
 * One recurring node: the node plus its series (rule + anchor day). The rule
 * lives on a date value's metadata (`repeat`); the anchor is that value's own
 * day — occurrences derive at read time, never as nodes.
 */
export interface RecurringRow {
  node: ClientNode;
  rule: RecurrenceRule;
  anchorIso: string;
}

/**
 * Every recurring series in the workspace: a scan of the document-chrome
 * nodes' effective date values for an authored `repeat` (the only materialized
 * hook recurrence has — occurrences are virtual, so the month dots and the
 * day sections both start from this list). One node contributes at most one
 * series (its first repeating date value wins). Date-chain nodes are skipped;
 * a rule on a value without a day-precision anchor is ignored (the picker
 * only writes day-anchored rules); a present-but-corrupt rule THROWS
 * (recurrenceRuleOf is fail loud — corrupt metadata never reads as plain).
 */
export function recurringRowsOf(client: AnyClient): RecurringRow[] {
  const rows: RecurringRow[] = [];
  for (const node of client.listPages()) {
    if (parseDateNodeId(node.id) !== null) continue;
    for (const prop of client.getEffectiveProperties(node.id)) {
      if (prop.source !== "authored") continue;
      if (prop.schema?.type !== "datetime") continue;
      const rule = recurrenceRuleOf(prop.metadata);
      if (rule === null) continue;
      const anchorIso = scheduledIsoOf(prop.value);
      if (anchorIso === null) continue;
      rows.push({ node, rule, anchorIso });
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

/** One Dated-section row: the node plus its recurrence rule, null when plain. */
export interface DatedRow {
  node: ClientNode;
  /** The node's series rule when it repeats (started by the viewed day). */
  rule: RecurrenceRule | null;
}

/**
 * The Dated rows for one day: the day node's materialized backlink
 * set (datedRowNodes) UNION the recurring nodes occurring on this day —
 * occurrences are virtual, so the backlink read alone can't see them. The
 * anchor day of a recurring node is already in the backlink set; the union
 * dedupes by id and marks it with the rule. Callers pre-filter
 * `recurringRows` (e.g. tasks out — they have their own section).
 */
export function datedRowsForDay(
  client: AnyClient,
  iso: string,
  recurringRows: readonly RecurringRow[],
): DatedRow[] {
  const rows = new Map<string, DatedRow>();
  for (const node of datedRowNodes(client, dayNodeId(iso))) {
    rows.set(node.id, { node, rule: null });
  }
  for (const entry of recurringRows) {
    if (entry.anchorIso <= iso && rows.has(entry.node.id)) {
      rows.get(entry.node.id)!.rule = entry.rule;
      continue;
    }
    if (entry.anchorIso > iso) continue; // series hasn't started
    if (!occursOnDay(entry.rule, entry.anchorIso, iso)) continue;
    rows.set(entry.node.id, { node: entry.node, rule: entry.rule });
  }
  const merged = [...rows.values()];
  merged.sort(
    (a, b) =>
      (displayNameFromClient(client, a.node.id) ?? a.node.id).localeCompare(
        displayNameFromClient(client, b.node.id) ?? b.node.id,
      ) || a.node.id.localeCompare(b.node.id),
  );
  return merged;
}

// --- events list (the panel's events element) --------------------------------

/**
 * The Events-list rows for a scope of days (the calendar panel's events
 * element below the mini-month, owner 2026-10-23): event-family nodes — the
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
 * by id (dated beats embedded — one row per node), sorted by display name.
 */
export function eventRowsForDays(
  client: AnyClient,
  isos: readonly string[],
  recurringRows: readonly RecurringRow[],
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
  const addNode = (node: ClientNode, rule: RecurrenceRule | null): void => {
    const existing = rows.get(node.id);
    if (existing !== undefined) {
      if (existing.rule === null && rule !== null) existing.rule = rule;
      return;
    }
    rows.set(node.id, { node, rule });
  };

  for (const iso of isos) {
    const dayId = dayNodeId(iso);
    for (const node of datedRowNodes(client, dayId)) {
      if (isEventNode(node)) addNode(node, null);
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
          addNode(child, null);
        }
      }
    }
    for (const entry of recurringRows) {
      if (!isEventNode(entry.node)) continue;
      if (entry.anchorIso <= iso && rows.has(entry.node.id)) {
        rows.get(entry.node.id)!.rule = entry.rule;
        continue;
      }
      if (entry.anchorIso > iso) continue; // series hasn't started
      if (!occursOnDay(entry.rule, entry.anchorIso, iso)) continue;
      addNode(entry.node, entry.rule);
    }
  }

  const merged = [...rows.values()];
  merged.sort(
    (a, b) =>
      (displayNameFromClient(client, a.node.id) ?? a.node.id).localeCompare(
        displayNameFromClient(client, b.node.id) ?? b.node.id,
      ) || a.node.id.localeCompare(b.node.id),
  );
  return merged;
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
