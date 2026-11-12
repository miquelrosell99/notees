/**
 * calendarRecurrence — the recurring-event edit/delete SEMANTICS every
 * calendar app ships: acting on
 * one occurrence of a series asks the scope —
 *
 *   - "all"      — the series node itself (the pre-existing behavior);
 *   - "one"      — only the acted-on day: deletes add it to the series'
 *                  `exdates`; edits detach into a new ORDINARY event node
 *                  (content/classes/properties copied, a plain date at the
 *                  edited day, NO rule) and the original day joins
 *                  `exdates` (Google's detached-instance semantics);
 *   - "following"— the series truncates at the last occurrence before the
 *                  acted-on day (`until`) and a CONTINUATION node carries
 *                  the edited values forward with the same rule (a fresh
 *                  series: `until` drops, future exdates move with it).
 *                  When no occurrence precedes the day (it IS the anchor)
 *                  the scope degenerates to "all".
 *
 * All writes are ordinary ops (property.set of the Repeat value's metadata,
 * object.create for the copies) — no wire change; the exception state is
 * additive metadata on the Repeat property value (SCHEMA.md "Recurrence",
 * the completedOccurrences precedent). The dialog that asks the scope is a
 * later slice; this module is the semantic core the UI routes to.
 */

import { uuidv7 } from "uuidv7";

import {
  SYSTEM_PROPERTY_UUIDS,
  dayNodeId,
  exdatesOf,
  formatRecurrenceRule,
  occurrenceIsosOf,
  recurrenceSeriesOf,
  withExdate,
  withUntil,
  type RecurrenceSeries,
} from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, ClientWriteOp, WorkspaceClient } from "@/core/workspace-client/index.js";

import { addDaysIso } from "./calendarViewUtils.js";
import {
  drivingDateRow,
  repeatFactsOfNode,
  setRepeatMetadata,
  type RepeatFacts,
} from "./repeatProperty.js";

type AnyClient = WorkspaceClient | WorkerClient;

export type RecurrenceScope = "one" | "following" | "all";

/** The edit applied to the acted-on occurrence (slice 1: the drag move). */
export interface OccurrenceEdit {
  /** Move the occurrence to this day. */
  toIso: string;
}

interface RecurringDateRow {
  /** The driving date row (schema + idx + value) — the anchor move's write. */
  dateSchemaId: string;
  dateIdx: number;
  dateValue: unknown;
  dateMetadata: unknown;
  /** The Repeat facts: rule, anchor day, the exception-metadata carrier. */
  facts: RepeatFacts;
  /** The full expansion input (rule + anchor + exdates/until). */
  series: RecurrenceSeries;
}

/** The node's authored recurrence (the Repeat value + a driving date), if any. */
function recurringDateRowOf(client: AnyClient, nodeId: string): RecurringDateRow | null {
  const facts = repeatFactsOfNode(client, nodeId);
  if (facts === null) return null;
  const driving = drivingDateRow(client, nodeId);
  if (driving === null) return null; // facts non-null implies a driving row
  return {
    dateSchemaId: driving.row.propertySchemaId,
    dateIdx: driving.row.idx,
    dateValue: driving.row.value,
    dateMetadata: driving.row.metadata,
    facts,
    series: recurrenceSeriesOf(facts.rule, facts.row.metadata, facts.anchorIso)!,
  };
}

/**
 * The last series occurrence strictly before `iso`, or null when none
 * (the acted-on day is the anchor or earlier — "following" degenerates to
 * "all"). The probe window is sized from the rule's granularity so it
 * always contains at least one occurrence when one exists.
 */
function previousOccurrenceBefore(series: RecurrenceSeries, iso: string): string | null {
  if (series.anchorIso >= iso) return null;
  const probeFrom = probeWindowStart(series, iso);
  const occurrences = occurrenceIsosOf(series, probeFrom, addDaysIso(iso, -1));
  return occurrences.length > 0 ? occurrences[occurrences.length - 1]! : null;
}

/** A from-iso far enough back that the window holds ≥ 1 occurrence. */
function probeWindowStart(series: RecurrenceSeries, iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const clamp = (day: number): number => Math.min(day, 28);
  switch (series.rule.freq) {
    case "daily":
      return addDaysIso(iso, -(series.rule.interval + 1));
    case "weekly":
      return addDaysIso(iso, -(series.rule.interval * 7 + 1));
    case "monthly": {
      const total = y! * 12 + (m! - 1) - (series.rule.interval + 1);
      const yy = Math.floor(total / 12);
      const mm = (total % 12) + 1;
      return `${yy}-${String(mm).padStart(2, "0")}-${String(clamp(d!)).padStart(2, "0")}`;
    }
    case "yearly": {
      const yy = y! - (series.rule.interval + 1);
      return `${yy}-${String(m!).padStart(2, "0")}-${String(clamp(d!)).padStart(2, "0")}`;
    }
  }
}

/** The datetime value pointing at the given day ({nodeId} shape). */
function dateValueFor(iso: string): { nodeId: string } {
  return { nodeId: dayNodeId(iso) };
}

/**
 * Copy `source` into a fresh node: content + classes + every authored
 * property value (multi-value slots per idx), EXCEPT the driving date
 * schema (the caller writes the new date) and the Repeat property (the
 * caller re-mints it — an exception omits it entirely, a continuation
 * carries the fresh rule). Children stay on the source —
 * an exception is the node's own row (the design ruling). The create +
 * every setProperty ride ONE applyOps batch ("Undo edit occurrence") —
 * the create's id is caller-assigned so the property ops anchor to it;
 * the caller resolves the target date chain BEFORE calling (the date-ref
 * contract stays outside the batch).
 */
async function copyEventNode(
  client: AnyClient,
  source: ClientNode,
  dateSchemaId: string,
  dateValue: unknown,
  dateMetadata: Record<string, unknown> | undefined,
  repeat?: { value: string; metadata: Record<string, unknown> | undefined },
): Promise<string> {
  const id = uuidv7();
  const ops: ClientWriteOp[] = [
    {
      kind: "create",
      input: {
        id,
        isEmbedded: source.isEmbedded,
        ...(source.parentId !== null ? { parentId: source.parentId } : {}),
        contentAst: source.contentAst,
        classIds: source.classIds,
      },
    },
  ];
  for (const prop of client.getEffectiveProperties(source.id)) {
    if (prop.source !== "authored") continue;
    if (prop.propertySchemaId === dateSchemaId) continue;
    if (prop.propertySchemaId === SYSTEM_PROPERTY_UUIDS.repeat) continue;
    ops.push({
      kind: "setProperty",
      objectId: id,
      propertySchemaId: prop.propertySchemaId,
      value: prop.value,
      idx: prop.idx ?? 0,
      ...(prop.metadata !== null ? { metadata: prop.metadata } : {}),
    });
  }
  if (repeat !== undefined) {
    ops.push({
      kind: "setProperty",
      objectId: id,
      propertySchemaId: SYSTEM_PROPERTY_UUIDS.repeat,
      value: repeat.value,
      idx: 0,
      ...(repeat.metadata !== undefined ? { metadata: repeat.metadata } : {}),
    });
  }
  ops.push({
    kind: "setProperty",
    objectId: id,
    propertySchemaId: dateSchemaId,
    value: dateValue,
    idx: 0,
    ...(dateMetadata !== undefined ? { metadata: dateMetadata } : {}),
  });
  await client.applyOps(ops, { verb: "edit occurrence" });
  return id;
}

/**
 * Delete one occurrence of a recurring event per the scope. Non-recurring
 * nodes (and scope "all") trash the node itself.
 */
export async function deleteOccurrence(
  client: AnyClient,
  nodeId: string,
  iso: string,
  scope: RecurrenceScope,
): Promise<void> {
  const row = recurringDateRowOf(client, nodeId);
  if (row === null || scope === "all") {
    await client.deleteObject(nodeId);
    return;
  }
  if (scope === "one") {
    await setRepeatMetadata(client, nodeId, withExdate(row.facts.row.metadata, iso));
    return;
  }
  // "following": truncate at the previous occurrence; no predecessor = all.
  const previous = previousOccurrenceBefore(row.series, iso);
  if (previous === null) {
    await client.deleteObject(nodeId);
    return;
  }
  await setRepeatMetadata(client, nodeId, withUntil(row.facts.row.metadata, previous));
}

/**
 * Apply an edit to one occurrence of a recurring event per the scope.
 * Returns the id of the created node (exception / continuation) or null
 * when the series node itself absorbed the edit ("all", or the degenerate
 * "following" at the anchor).
 */
export async function editOccurrence(
  client: AnyClient,
  nodeId: string,
  iso: string,
  scope: RecurrenceScope,
  edit: OccurrenceEdit,
): Promise<string | null> {
  const row = recurringDateRowOf(client, nodeId);
  if (row === null || scope === "all") {
    if (row === null) return null;
    // The whole series moves: the driving date re-commits at the edited day,
    // the Repeat value + exception metadata riding along untouched. The
    // target day node must exist before the value references it (the
    // date-ref contract).
    await client.ensureDateChain(edit.toIso);
    await client.setProperty(
      nodeId,
      row.dateSchemaId,
      dateValueFor(edit.toIso),
      row.dateIdx,
      (row.dateMetadata ?? undefined) as Record<string, unknown> | undefined,
    );
    return null;
  }
  if (scope === "one") {
    const source = client.getNode(nodeId);
    if (source === undefined) return null;
    await client.ensureDateChain(edit.toIso);
    // The exception: an ordinary event at the edited day, no rule.
    const exceptionId = await copyEventNode(
      client,
      source,
      row.dateSchemaId,
      dateValueFor(edit.toIso),
      undefined,
    );
    await setRepeatMetadata(client, nodeId, withExdate(row.facts.row.metadata, iso));
    return exceptionId;
  }
  // "following": truncate, then continue with the same rule from the edit.
  const source = client.getNode(nodeId);
  if (source === undefined) return null;
  await client.ensureDateChain(edit.toIso);
  const previous = previousOccurrenceBefore(row.series, iso);
  if (previous === null) {
    await client.setProperty(
      nodeId,
      row.dateSchemaId,
      dateValueFor(edit.toIso),
      row.dateIdx,
      (row.dateMetadata ?? undefined) as Record<string, unknown> | undefined,
    );
    return null;
  }
  const continuationAnchor = edit.toIso;
  const futureExdates = exdatesOf(row.facts.row.metadata).filter(
    (day) => day >= continuationAnchor,
  );
  // The continuation re-mints the rule canonically (format→parse
  // round-trips); `until` drops (a fresh series) and future exdates move.
  const continuationRepeat = {
    value: formatRecurrenceRule(row.series.rule),
    metadata: futureExdates.length > 0 ? { exdates: futureExdates } : undefined,
  };
  const continuationId = await copyEventNode(
    client,
    source,
    row.dateSchemaId,
    dateValueFor(continuationAnchor),
    undefined,
    continuationRepeat,
  );
  await setRepeatMetadata(client, nodeId, withUntil(row.facts.row.metadata, previous));
  return continuationId;
}
