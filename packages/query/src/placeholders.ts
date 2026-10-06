/**
 * Query compile-time placeholders — the `{today}`-style editor-relative date
 * tokens. A placeholder is an ordinary string in the AST (the
 * zod model accepts any string in the positions that carry them), resolved to
 * a concrete date at COMPILE time, so a saved view authored with `{today}`
 * re-evaluates against the day it runs on — every surface (web live tokens,
 * CLI, server API) that compiles an AST gets the same semantics.
 *
 * Supported set (deliberately small):
 *  - `{today}`       — the current day
 *  - `{this_week}`   — the current ISO week (Monday start)
 *  - `{this_month}`  — the current month
 *  - `{this_year}`   — the current year
 *
 * Positions (see the compiler's wiring):
 *  - `createdAfter` / `createdBefore` timestamps resolve to an ISO-8601
 *    DATETIME at the period's local start (After) or local end (Before),
 *    expressed in UTC (created_at is UTC on the wire) — so
 *    `createdBefore: "{today}"` includes everything created on the local
 *    day, whatever the machine's offset;
 *  - property-condition string values resolve to the period's START as a
 *    plain `YYYY-MM-DD` date — the same shape as typing the date by hand,
 *    so the ISO-date arms (incl. the date-node-ref containment match)
 *    apply, and range ops keep their natural reading against that bound
 *    (`< {today}` = before today).
 *
 * Anything outside the known set is left verbatim — a literal "{banana}"
 * value stays a literal (compile never crashes on foreign data).
 *
 * The C4 note: the compiler once reserved a `currentNodeId` option for
 * node-relative scopes; that option was dead (the strict AST carries explicit
 * ids — "this page" is baked at write time by the builder) and is removed.
 * These placeholders are the only compile-context resolution the model has.
 */

/** The supported placeholder tokens, in picker order. */
export const QUERY_PLACEHOLDERS = ["{today}", "{this_week}", "{this_month}", "{this_year}"] as const;

export type QueryPlaceholder = (typeof QUERY_PLACEHOLDERS)[number];

/** The compile clock — tests pin `now`; runtime defaults to the current instant. */
export interface PlaceholderContext {
  now?: Date | undefined;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `YYYY-MM-DD` for a Date's local calendar day. */
export function isoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The UTC instant of a local calendar day's boundary (00:00 local for the
 * start, 23:59:59.999 local for the end), as an ISO-8601 string comparable
 * lexicographically with the UTC `created_at` wire format.
 */
function localDayBoundaryUtc(iso: string, end: boolean): string {
  const [year, month, day] = iso.split("-").map((part) => Number(part));
  const boundary = new Date(year!, month! - 1, day!, 0, 0, 0, 0);
  if (end) boundary.setHours(23, 59, 59, 999);
  return boundary.toISOString();
}

/** The placeholder's period-start date, or null when the token is not one. */
export function placeholderStartDate(token: string, context: PlaceholderContext = {}): string | null {
  const now = context.now ?? new Date();
  switch (token) {
    case "{today}":
      return isoDate(now);
    case "{this_week}": {
      // ISO-8601 week: Monday is day 1; getDay() has Sunday at 0.
      const monday = new Date(now);
      monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
      return isoDate(monday);
    }
    case "{this_month}":
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
    case "{this_year}":
      return `${now.getFullYear()}-01-01`;
    default:
      return null;
  }
}

/** The placeholder's period-end date, or null when the token is not one. */
export function placeholderEndDate(token: string, context: PlaceholderContext = {}): string | null {
  const now = context.now ?? new Date();
  switch (token) {
    case "{today}":
      return isoDate(now);
    case "{this_week}": {
      const sunday = new Date(now);
      sunday.setDate(now.getDate() - ((now.getDay() + 6) % 7) + 6);
      return isoDate(sunday);
    }
    case "{this_month}":
      return isoDate(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    case "{this_year}":
      return `${now.getFullYear()}-12-31`;
    default:
      return null;
  }
}

/**
 * Resolve a placeholder in a TIMESTAMP position (`createdAfter`/`createdBefore`):
 * the period's local day start for After (inclusive floor), local day end
 * for Before (inclusive ceiling), each expressed in UTC (see
 * localDayBoundaryUtc). Non-placeholder input is returned as-is.
 */
export function resolveTimestampPlaceholder(
  value: string,
  direction: "after" | "before",
  context: PlaceholderContext = {},
): string {
  const resolved =
    direction === "after" ? placeholderStartDate(value, context) : placeholderEndDate(value, context);
  if (resolved === null) return value;
  return localDayBoundaryUtc(resolved, direction === "before");
}

/**
 * Resolve a placeholder in a PROPERTY-VALUE position: the period start as a
 * plain `YYYY-MM-DD` date (the shape a hand-typed date would have). Non-placeholder
 * input is returned as-is.
 */
export function resolveValuePlaceholder(value: string, context: PlaceholderContext = {}): string {
  return placeholderStartDate(value, context) ?? value;
}
