/**
 * The datetime property value readers of the metadata panel: the stored
 * union's slot decomposition (point / range arms), the schema's commit
 * ceiling, and the ISO formatting helpers for the date-picker popup and
 * the link-qualifier slots. Pure moves from the historical
 * `MetadataSection.tsx`.
 */

import {
  isValidTimeOfDay,
  parseDateNodeId,
  type DatePrecision,
  type DatetimeSlot,
} from "@notees/domain";

import { nodeRefOf } from "./shared.js";

/**
 * One datetime slot of a stored value: the chain ref plus an optional
 * wall-clock time ({ nodeId, time? } — the SCHEMA.md "Datetime" union arm).
 * A bare string ref is accepted leniently; anything without a ref is null.
 */
export function slotOf(value: unknown): DatetimeSlot | null {
  const ref = nodeRefOf(value);
  if (ref === null) return null;
  const time =
    typeof value === "object" && value !== null
      ? (value as { time?: unknown }).time
      : undefined;
  return isValidTimeOfDay(time) ? { nodeId: ref, time } : { nodeId: ref };
}

/** The range arm of the union: { start, end } of slots, either side open. */
export interface DatetimeRangeSlots {
  start: DatetimeSlot | null;
  end: DatetimeSlot | null;
}

export function rangeSlotsOf(value: unknown): DatetimeRangeSlots {
  if (typeof value !== "object" || value === null) return { start: null, end: null };
  const range = value as { start?: unknown; end?: unknown };
  return { start: slotOf(range.start), end: slotOf(range.end) };
}

/** The schema's commit ceiling for date values (day when unspecified). */
export function precisionOf(schema: { datePrecision?: DatePrecision | null } | null | undefined): DatePrecision {
  return schema?.datePrecision ?? "day";
}

/** A date ref back to a full ISO date at its own precision (range merges). */
export function isoOfRef(ref: string | null): string | null {
  if (ref === null) return null;
  const parsed = parseDateNodeId(ref);
  if (parsed === null) return null;
  const y = String(parsed.year).padStart(4, "0");
  const m = String(parsed.month).padStart(2, "0");
  const d = String(parsed.day).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * PC6 read-leniency: a qualifier slot reads BOTH shapes — a legacy ISO
 * string rides as-is; a canonical date-node ref formats from its
 * deterministic id (day precision `YYYY-MM-DD`). The panel still WRITES the
 * legacy string until the lockstep wave (the applier normalizes on write).
 */
export function qualifierIsoOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "nodeId" in value) {
    const id = (value as { nodeId: unknown }).nodeId;
    if (typeof id === "string") {
      const parsed = parseDateNodeId(id);
      if (parsed !== null) {
        return `${String(parsed.year).padStart(4, "0")}-${String(parsed.month).padStart(2, "0")}-${String(parsed.day).padStart(2, "0")}`;
      }
      return id;
    }
  }
  return "";
}
