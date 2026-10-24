/**
 * calendarRecurrence — the recurring-event edit/delete SEMANTICS every
 * calendar app ships (owner 2026-10-23, the Google register): acting on
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
 * All writes are ordinary ops (property.set of the date value's metadata,
 * object.create for the copies) — no wire change; the exception state is
 * additive metadata on the same date value (SCHEMA.md "Recurrence", the
 * completedOccurrences precedent). The dialog that asks the scope is a
 * later slice; this module is the semantic core the UI routes to.
 */

import {
  dayNodeId,
  exdatesOf,
  occurrenceIsosOf,
  recurrenceRuleOf,
  withExdate,
  withUntil,
  type RecurrenceSeries,
} from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client/index.js";

import { addDaysIso, scheduledIsoOf } from "./calendarViewUtils.js";

type AnyClient = WorkspaceClient | WorkerClient;

export type RecurrenceScope = "one" | "following" | "all";

/** The edit applied to the acted-on occurrence (slice 1: the drag move). */
export interface OccurrenceEdit {
  /** Move the occurrence to this day. */
  toIso: string;
}

interface RecurringDateRow {
  schemaId: string;
  idx: number;
  /** The committed value ({nodeId: the anchor's day node}). */
  value: unknown;
  metadata: unknown;
  series: RecurrenceSeries;
}

/** The node's authored recurring date value (the series carrier), if any. */
function recurringDateRowOf(client: AnyClient, nodeId: string): RecurringDateRow | null {
  for (const prop of client.getEffectiveProperties(nodeId)) {
    if (prop.source !== "authored") continue;
    if (prop.schema?.type !== "datetime") continue;
    if (recurrenceRuleOf(prop.metadata) === null) continue;
    const iso = scheduledIsoOf(prop.value);
    if (iso === null) continue;
    return {
      schemaId: prop.propertySchemaId,
      idx: prop.idx ?? 0,
      value: prop.value,
      metadata: prop.metadata,
      series: {
        rule: recurrenceRuleOf(prop.metadata)!,
        anchorIso: iso,
        ...(exdatesOf(prop.metadata).length > 0 ? { exdates: exdatesOf(prop.metadata) } : {}),
      },
    };
  }
  return null;
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
    case "weekdays":
      return addDaysIso(iso, -4);
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
 * schema (the caller writes the new date). Children stay on the source —
 * an exception is the node's own row (the design ruling).
 */
async function copyEventNode(
  client: AnyClient,
  source: ClientNode,
  dateSchemaId: string,
  dateValue: unknown,
  dateMetadata: Record<string, unknown> | undefined,
): Promise<string> {
  const id = await client.createObject({
    isEmbedded: source.isEmbedded,
    ...(source.parentId !== null ? { parentId: source.parentId } : {}),
    contentAst: source.contentAst,
    classIds: source.classIds,
  });
  for (const prop of client.getEffectiveProperties(source.id)) {
    if (prop.source !== "authored") continue;
    if (prop.propertySchemaId === dateSchemaId) continue;
    await client.setProperty(id, prop.propertySchemaId, prop.value, prop.idx ?? 0, prop.metadata ?? undefined);
  }
  await client.setProperty(id, dateSchemaId, dateValue, 0, dateMetadata);
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
    await client.setProperty(nodeId, row.schemaId, row.value, row.idx, withExdate(row.metadata, iso));
    return;
  }
  // "following": truncate at the previous occurrence; no predecessor = all.
  const previous = previousOccurrenceBefore(row.series, iso);
  if (previous === null) {
    await client.deleteObject(nodeId);
    return;
  }
  await client.setProperty(nodeId, row.schemaId, row.value, row.idx, withUntil(row.metadata, previous));
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
    // The whole series moves: the anchor re-commits at the edited day, the
    // rule + exception metadata riding along untouched. The target day node
    // must exist before the value references it (the date-ref contract).
    await client.ensureDateChain(edit.toIso);
    await client.setProperty(nodeId, row.schemaId, dateValueFor(edit.toIso), row.idx, row.metadata as Record<string, unknown> | undefined);
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
      row.schemaId,
      dateValueFor(edit.toIso),
      undefined,
    );
    await client.setProperty(nodeId, row.schemaId, row.value, row.idx, withExdate(row.metadata, iso));
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
      row.schemaId,
      dateValueFor(edit.toIso),
      row.idx,
      row.metadata as Record<string, unknown> | undefined,
    );
    return null;
  }
  const continuationAnchor = edit.toIso;
  const futureExdates = exdatesOf(row.metadata).filter((day) => day >= continuationAnchor);
  const continuationMetadata: Record<string, unknown> = {
    repeat: row.series.rule.interval >= 2
      ? `${row.series.rule.freq}/${row.series.rule.interval}`
      : row.series.rule.freq,
    ...(futureExdates.length > 0 ? { exdates: futureExdates } : {}),
  };
  const continuationId = await copyEventNode(
    client,
    source,
    row.schemaId,
    dateValueFor(continuationAnchor),
    continuationMetadata,
  );
  await client.setProperty(nodeId, row.schemaId, row.value, row.idx, withUntil(row.metadata, previous));
  return continuationId;
}
