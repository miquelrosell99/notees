/**
 * repeatProperty — the read/write seam behind the dedicated Repeat text
 * property (schema id `SYSTEM_PROPERTY_UUIDS.repeat`): the canonical RRULE
 * string (or a `{nodeId}` carrier whose target block's flattened text IS the
 * rule) plus the exception metadata (exdates / until) and the per-occurrence
 * completion days (completedOccurrences) riding the value's metadata. The
 * series anchor is never stored here — it is the driving datetime row's own
 * day (event family: eventDate; tasks: taskScheduled), so re-picking the
 * date moves the series while this value rides verbatim.
 *
 * Text is a HEAVY property type: the shells read withholds the value (null,
 * only `valueCount`), so the workspace-wide scan is two-pass — the shells
 * find candidate nodes (an authored Repeat row with valueCount ≥ 1), then
 * the full `getEffectiveProperties` read runs only for those. The exception
 * readers are the domain's fail-loud exports: a present-but-corrupt rule or
 * metadata throws, never reads as plain.
 */

import {
  SYSTEM_PROPERTY_UUIDS,
  formatRecurrenceRule,
  parseRecurrenceRule,
  plainTextExcerpt,
  weekdayOfIso,
  type RecurrenceRule,
  type RecurrenceWeekday,
} from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type {
  EffectiveProperty,
  PropertyRowShell,
  WorkspaceClient,
} from "@/core/workspace-client/index.js";

import { scheduledIsoOf } from "./calendarViewUtils.js";

type AnyClient = WorkspaceClient | WorkerClient;

/** One node's recurrence facts: the parsed rule, the anchor day, the row. */
export interface RepeatFacts {
  rule: RecurrenceRule;
  anchorIso: string;
  /** The authored Repeat row — the value (verbatim) + the exception metadata. */
  row: EffectiveProperty;
}

/**
 * The node's authored Repeat row resolved to facts, null when no repeat
 * value. Two-pass: the shells read finds the authored Repeat row
 * (valueCount ≥ 1 — text defers the value), the full read resolves it. The
 * value is a plain RRULE string or a `{nodeId}` carrier (resolved through
 * {@link repeatTextOf}); a present-but-unparsable value throws
 * RecurrenceParseError (fail loud — corrupt never reads as plain). The
 * anchor is the driving datetime row's day; a repeat value without a
 * resolvable anchor reads as null (the series occurs nowhere).
 */
export function repeatFactsOfNode(client: AnyClient, nodeId: string): RepeatFacts | null {
  const shell = repeatShellOf(client, nodeId);
  if (shell === null) return null;
  const row = client
    .getEffectiveProperties(nodeId)
    .find(
      (prop) =>
        prop.propertySchemaId === SYSTEM_PROPERTY_UUIDS.repeat &&
        prop.source === "authored" &&
        (prop.idx ?? 0) === shell.idx,
    );
  if (row === undefined) return null;
  const text = repeatTextOf(client, row.value);
  if (text === null) return null;
  const rule = parseRecurrenceRule(text);
  const anchorIso = drivingDateRow(client, nodeId)?.anchorIso;
  if (anchorIso === undefined) return null;
  return { rule, anchorIso, row };
}

/**
 * The Repeat value as an RRULE string: a plain string as-is; a `{nodeId}`
 * carrier resolves to the target node's flattened text content; anything
 * else → null (the caller's `parseRecurrenceRule` then throws fail-loud on
 * the non-null arms; a null here means "no repeat value").
 */
export function repeatTextOf(client: AnyClient, value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const nodeId = (value as { nodeId?: unknown }).nodeId;
  if (typeof nodeId !== "string") return null;
  const node = client.getNode(nodeId);
  if (node === undefined) return null;
  return plainTextExcerpt(node.contentAst).trim();
}

/**
 * The node's driving datetime row — the FIRST authored datetime value with a
 * resolvable day — plus that day (the series anchor source every recurrence
 * read shares; datetime is a LIGHT type so the shells read carries the
 * value).
 */
export function drivingDateRow(
  client: AnyClient,
  nodeId: string,
): { row: PropertyRowShell; anchorIso: string } | null {
  for (const prop of client.getPropertyRowShells(nodeId)) {
    if (prop.source !== "authored") continue;
    if (prop.schema?.type !== "datetime") continue;
    const anchorIso = scheduledIsoOf(prop.value);
    if (anchorIso === null) continue;
    return { row: prop, anchorIso };
  }
  return null;
}

/** The authored Repeat shell (the cheap candidacy probe), null when absent. */
function repeatShellOf(client: AnyClient, nodeId: string): PropertyRowShell | null {
  for (const prop of client.getPropertyRowShells(nodeId)) {
    if (prop.propertySchemaId !== SYSTEM_PROPERTY_UUIDS.repeat) continue;
    if (prop.source !== "authored") continue;
    if (prop.valueCount < 1) continue;
    return prop;
  }
  return null;
}

const WEEKDAY_SHORT: Record<RecurrenceWeekday, string> = {
  MO: "Mon",
  TU: "Tue",
  WE: "Wed",
  TH: "Thu",
  FR: "Fri",
  SA: "Sat",
  SU: "Sun",
};

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * The human summary of a series (the repeat control's option labels and the
 * calendar labels): "Every 2 weeks on Mon, Fri", "Monthly on day 3",
 * "Yearly on 29 Feb". The anchor supplies what the rule leaves implicit
 * (the weekly weekday, the monthly day-of-month, the yearly month+day). The
 * end rides as a suffix: " · ends after 10 occurrences" / " · ends 31 Dec
 * 2026"; an unbounded rule omits the suffix.
 */
export function repeatSummaryOf(rule: RecurrenceRule, anchorIso: string): string {
  const [, m, d] = anchorIso.split("-").map(Number);
  const anchorWeekday = weekdayOfIso(anchorIso);
  const every = (unit: string): string => `Every ${rule.interval} ${unit}s`;
  let base: string;
  switch (rule.freq) {
    case "daily":
      base = rule.interval === 1 ? "Daily" : every("day");
      break;
    case "weekly": {
      const days = (rule.byday ?? [anchorWeekday]).map((day) => WEEKDAY_SHORT[day]);
      base = `${rule.interval === 1 ? "Weekly" : every("week")} on ${days.join(", ")}`;
      break;
    }
    case "monthly": {
      const days = rule.bymonthday ?? [d!];
      base = `${rule.interval === 1 ? "Monthly" : every("month")} on day ${days.join(", ")}`;
      break;
    }
    case "yearly":
      base = `${rule.interval === 1 ? "Yearly" : every("year")} on ${d} ${MONTH_SHORT[m! - 1]}`;
      break;
  }
  if (rule.count !== undefined) {
    const plural = rule.count === 1 ? "occurrence" : "occurrences";
    return `${base} · ends after ${rule.count} ${plural}`;
  }
  if (rule.until !== undefined) {
    const [uy, um, ud] = rule.until.split("-").map(Number);
    return `${base} · ends ${ud} ${MONTH_SHORT[um! - 1]} ${uy}`;
  }
  return base;
}

/**
 * Author (or clear, null) the node's Repeat rule: the canonical RRULE string
 * at the existing row's idx, the row's exception metadata riding through
 * untouched (changing the rule does not clear exdates/until). Validation is
 * the caller's job — a malformed rule throws from formatRecurrenceRule.
 */
export async function setRepeatRule(
  client: AnyClient,
  nodeId: string,
  rule: RecurrenceRule | null,
): Promise<void> {
  const shell = repeatShellOf(client, nodeId);
  if (rule === null) {
    await client.unsetProperty(nodeId, SYSTEM_PROPERTY_UUIDS.repeat, shell?.idx ?? 0);
    return;
  }
  await client.setProperty(
    nodeId,
    SYSTEM_PROPERTY_UUIDS.repeat,
    formatRecurrenceRule(rule),
    shell?.idx ?? 0,
    shell?.metadata ?? undefined,
  );
}

/**
 * Re-commit the Repeat value verbatim with new exception metadata — the
 * write path behind withExdate / withUntil / withCompletedOccurrence (the
 * value is the series' identity; only the metadata changes). An empty
 * metadata clears the slot's metadata entirely (absent-is-default).
 */
export async function setRepeatMetadata(
  client: AnyClient,
  nodeId: string,
  metadata: unknown,
): Promise<void> {
  const row = client
    .getEffectiveProperties(nodeId)
    .find(
      (prop) =>
        prop.propertySchemaId === SYSTEM_PROPERTY_UUIDS.repeat && prop.source === "authored",
    );
  if (row === undefined) return;
  const next =
    typeof metadata === "object" && metadata !== null && Object.keys(metadata).length === 0
      ? undefined
      : (metadata as Record<string, unknown> | undefined);
  await client.setProperty(nodeId, SYSTEM_PROPERTY_UUIDS.repeat, row.value, row.idx ?? 0, next);
}
