/**
 * Recurrence — the RR5 grammar behind repeating calendar events and tasks
 * (COMPUTE-ON-READ — no new op, no wire change).
 *
 * A recurrence rule lives as the value of a node's dedicated Repeat property:
 * an RFC-5545-style RRULE string over the supported subset ("RR5"). The
 * driving date value's own day IS the series anchor — the anchor is never
 * stored inside the rule (one source of truth: the linked day node).
 *
 * The calendar expands occurrences at READ time (occurrenceIsosOf); every
 * occurrence is VIRTUAL — no node per occurrence (design law: no hidden
 * objects), so editing the event edits the series and the month grid's dots
 * re-derive from the rule on every render.
 *
 * Canonical string grammar (the stored form):
 *
 *     RRULE:FREQ=<freq>[;INTERVAL=<n>][;BYDAY=<days>][;BYMONTHDAY=<days>]
 *                  [;COUNT=<n> | ;UNTIL=<day>]
 *
 *   <freq>       = DAILY | WEEKLY | MONTHLY | YEARLY (required, uppercase)
 *   INTERVAL     = integer 1..999 (default 1; omitted when 1)
 *   BYDAY        = comma list of MO..SU (weekday(s) within the week)
 *   BYMONTHDAY   = comma list of 1..31 (day(s) within the month)
 *   COUNT        = integer ≥ 1 — end after N generated occurrences
 *   UNTIL        = YYYYMMDD — inclusive last occurrence day
 *
 *   COUNT and UNTIL are mutually exclusive. One canonical key order (FREQ
 *   first; INTERVAL; BYDAY; BYMONTHDAY; COUNT|UNTIL) — parse rejects any
 *   other order and normalizes the list values (BYDAY into weekday order,
 *   BYMONTHDAY ascending); format emits the canonical form, so format→parse
 *   round-trips byte-identically.
 *
 * Semantics (pinned by the test suite):
 *   - occurrence #1 is the anchor day itself — a day d ≥ anchor occurs iff:
 *     (daily)   (d − anchor) % interval === 0;
 *     (weekly)  floor((d − anchor)/7) % interval === 0 AND weekday(d) is in
 *               BYDAY when set, else the anchor's weekday;
 *     (monthly) whole-month diff % interval === 0 AND day-of-month(d) is in
 *               BYMONTHDAY when set, else the anchor's day-of-month;
 *     (yearly)  whole-year diff % interval === 0 AND same month+day as the
 *               anchor (a Feb 29 anchor matches only leap years — never
 *               clamped);
 *   - a month without the BYMONTHDAY day SKIPS that month (day 31 in
 *     February → no occurrence, RRULE-style);
 *   - generated occurrences are then filtered: exdates remove days, COUNT
 *     drops generated occurrences past the index (exdates do NOT shift COUNT
 *     indices), UNTIL drops generated days past the bound (inclusive);
 *   - expansion walks the requested window day by day (each day in
 *     [max(anchor, fromIso), toIso] is tested), stopping at `cap`
 *     (default RECURRENCE_DEFAULT_CAP) — reads stay bounded, callers size
 *     the window.
 *
 * Parse is fail loud (dates.ts idiom): garbage in throws RecurrenceParseError,
 * never a silent non-recurring read. Anything outside the subset (BYSETPOS,
 * WKST, BYMONTH, …) is rejected outright — no backward compatibility.
 */

import { parseIsoDate, type DateParts } from "./dates.js";

export type RecurrenceFreq = "daily" | "weekly" | "monthly" | "yearly";

export type RecurrenceWeekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

/** Canonical weekday order — the BYDAY sort order. */
export const RECURRENCE_WEEKDAYS: readonly RecurrenceWeekday[] = [
  "MO",
  "TU",
  "WE",
  "TH",
  "FR",
  "SA",
  "SU",
];

/** Largest accepted INTERVAL. */
export const RECURRENCE_MAX_INTERVAL = 999;

/** Default occurrence cap for one expansion window (see occurrenceIsosOf). */
export const RECURRENCE_DEFAULT_CAP = 366;

/** A parsed RR5 rule. `until` is an inclusive ISO day (YYYY-MM-DD). */
export interface RecurrenceRule {
  freq: RecurrenceFreq;
  /** Every Nth period; 1 = every period. */
  interval: number;
  /** Weekday(s) within the week (WEEKLY; absent = the anchor's weekday). */
  byday?: readonly RecurrenceWeekday[];
  /** Day(s) within the month (MONTHLY; absent = the anchor's day-of-month). */
  bymonthday?: readonly number[];
  /** End after this many generated occurrences (exdates do not shift it). */
  count?: number;
  /** Inclusive last occurrence day (ISO YYYY-MM-DD). */
  until?: string;
}

/**
 * A rule anchored at its series' first day — the expansion input. The anchor
 * is the driving date value's own day (ISO YYYY-MM-DD), supplied by the
 * reader, never stored in the rule. The recurrence EXCEPTIONS ride along on
 * the Repeat value's metadata (the Google-calendar semantics): `exdates` are
 * occurrence days removed from the series (a deleted single occurrence, or
 * a day edited into an exception node) and `until` is the inclusive last
 * occurrence day (the bound a "this and following" split writes). Both
 * optional — absent means "no exceptions" / "unbounded".
 */
export interface RecurrenceSeries {
  rule: RecurrenceRule;
  anchorIso: string;
  /** Occurrence days removed from the series (sorted ISO days). */
  exdates?: readonly string[];
  /** Inclusive last occurrence day; occurrences after it do not exist. */
  until?: string;
}

/** Fail-loud marker for every recurrence parse/read failure. */
export class RecurrenceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecurrenceParseError";
  }
}

const RRULE_PREFIX = "RRULE:";
const YMD = /^(\d{4})(\d{2})(\d{2})$/;
const POSITIVE_INT = /^\d+$/;

const FREQ_BY_RRULE = new Map<string, RecurrenceFreq>([
  ["DAILY", "daily"],
  ["WEEKLY", "weekly"],
  ["MONTHLY", "monthly"],
  ["YEARLY", "yearly"],
]);

const RRULE_KEYS = ["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "COUNT", "UNTIL"];
/** Canonical key order — FREQ first, then INTERVAL, BYDAY, BYMONTHDAY, COUNT|UNTIL.
 * A Map (no inherited keys) so a segment naming an Object.prototype member is
 * an unknown key, never a rank. */
const KEY_ORDER = new Map<string, number>([
  ["FREQ", 0],
  ["INTERVAL", 1],
  ["BYDAY", 2],
  ["BYMONTHDAY", 3],
  ["COUNT", 4],
  ["UNTIL", 4],
]);
const WEEKDAY_SET: ReadonlySet<string> = new Set(RECURRENCE_WEEKDAYS);

function weekdayOrder(a: RecurrenceWeekday, b: RecurrenceWeekday): number {
  return RECURRENCE_WEEKDAYS.indexOf(a) - RECURRENCE_WEEKDAYS.indexOf(b);
}

/** A positive integer value in 1..max, fail loud. */
function parseBoundedInt(value: string, key: string, max: number): number {
  if (!POSITIVE_INT.test(value)) {
    throw new RecurrenceParseError(
      `invalid recurrence rule: ${key} must be a positive integer, got ${JSON.stringify(value)}`,
    );
  }
  const n = Number(value);
  if (n < 1 || n > max) {
    throw new RecurrenceParseError(
      `invalid recurrence rule: ${key} must be 1..${max}, got ${JSON.stringify(value)}`,
    );
  }
  return n;
}

function parseByday(value: string): RecurrenceWeekday[] {
  if (value === "") {
    throw new RecurrenceParseError(`invalid recurrence rule: BYDAY must not be empty`);
  }
  const days: RecurrenceWeekday[] = [];
  for (const token of value.split(",")) {
    if (!WEEKDAY_SET.has(token)) {
      throw new RecurrenceParseError(
        `invalid recurrence rule: unknown BYDAY weekday ${JSON.stringify(token)} ` +
          `(expected two-letter codes: ${RECURRENCE_WEEKDAYS.join(", ")})`,
      );
    }
    const day = token as RecurrenceWeekday;
    if (!days.includes(day)) days.push(day);
  }
  return days.sort(weekdayOrder);
}

function parseBymonthday(value: string): number[] {
  if (value === "") {
    throw new RecurrenceParseError(`invalid recurrence rule: BYMONTHDAY must not be empty`);
  }
  const days: number[] = [];
  for (const token of value.split(",")) {
    const day = parseBoundedInt(token, "BYMONTHDAY", 31);
    if (!days.includes(day)) days.push(day);
  }
  return days.sort((a, b) => a - b);
}

/** UNTIL (YYYYMMDD) → inclusive ISO day, validated against the real calendar. */
function parseUntil(value: string): string {
  const match = YMD.exec(value);
  if (match === null) {
    throw new RecurrenceParseError(
      `invalid recurrence rule: UNTIL must be a YYYYMMDD day, got ${JSON.stringify(value)}`,
    );
  }
  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  try {
    parseIsoDate(iso);
  } catch {
    throw new RecurrenceParseError(
      `invalid recurrence rule: UNTIL is not a real calendar day: ${JSON.stringify(value)}`,
    );
  }
  return iso;
}

/**
 * Parse a canonical `RRULE:` string — keys in the canonical order (FREQ
 * first, then INTERVAL, BYDAY, BYMONTHDAY, COUNT|UNTIL), uppercase, each at
 * most once. Throws RecurrenceParseError on anything else — legacy
 * `<freq>[/<n>]` forms, unknown keys, keys out of order, invalid values, and
 * COUNT+UNTIL together — with the supported vocabulary in the message.
 */
export function parseRecurrenceRule(text: unknown): RecurrenceRule {
  if (typeof text !== "string") {
    throw new RecurrenceParseError(
      `invalid recurrence rule: expected an RRULE string, got ${JSON.stringify(text)}`,
    );
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith(RRULE_PREFIX)) {
    throw new RecurrenceParseError(
      `invalid recurrence rule: ${JSON.stringify(text)} ` +
        `(expected a canonical RRULE string, e.g. "RRULE:FREQ=WEEKLY")`,
    );
  }
  const body = trimmed.slice(RRULE_PREFIX.length);
  if (body === "") {
    throw new RecurrenceParseError(`invalid recurrence rule: ${JSON.stringify(text)} (FREQ required)`);
  }

  let freq: RecurrenceFreq | undefined;
  let interval = 1;
  let byday: RecurrenceWeekday[] | undefined;
  let bymonthday: number[] | undefined;
  let count: number | undefined;
  let until: string | undefined;
  let lastOrder = -1;

  for (const segment of body.split(";")) {
    const eq = segment.indexOf("=");
    if (eq <= 0) {
      throw new RecurrenceParseError(
        `invalid recurrence rule: malformed segment ${JSON.stringify(segment)} in ${JSON.stringify(text)}`,
      );
    }
    const key = segment.slice(0, eq);
    const value = segment.slice(eq + 1);
    const order = KEY_ORDER.get(key);
    if (order === undefined) {
      throw new RecurrenceParseError(
        `invalid recurrence rule: unknown key ${JSON.stringify(key)} ` +
          `(supported: ${RRULE_KEYS.join(", ")})`,
      );
    }
    // Strictly increasing canonical order — this also rejects duplicates
    // (COUNT and UNTIL share a slot and are mutually exclusive below).
    if (order <= lastOrder) {
      throw new RecurrenceParseError(
        `invalid recurrence rule: keys out of canonical order in ${JSON.stringify(text)} ` +
          `(expected FREQ first, then ${RRULE_KEYS.slice(1, 4).join(", ")}, then COUNT|UNTIL)`,
      );
    }
    lastOrder = order;
    switch (key) {
      case "FREQ": {
        const parsed = FREQ_BY_RRULE.get(value);
        if (parsed === undefined) {
          throw new RecurrenceParseError(
            `invalid recurrence rule: unknown FREQ ${JSON.stringify(value)} ` +
              `(expected ${[...FREQ_BY_RRULE.keys()].join(", ")})`,
          );
        }
        freq = parsed;
        break;
      }
      case "INTERVAL":
        interval = parseBoundedInt(value, "INTERVAL", RECURRENCE_MAX_INTERVAL);
        break;
      case "BYDAY":
        byday = parseByday(value);
        break;
      case "BYMONTHDAY":
        bymonthday = parseBymonthday(value);
        break;
      case "COUNT":
        count = parseBoundedInt(value, "COUNT", Number.MAX_SAFE_INTEGER);
        break;
      case "UNTIL":
        until = parseUntil(value);
        break;
      default:
        // Unreachable while the switch covers every KEY_ORDER entry — kept
        // as the fail-loud backstop so an unknown key can never slip
        // through silently.
        throw new RecurrenceParseError(
          `invalid recurrence rule: unknown key ${JSON.stringify(key)} ` +
            `(supported: ${RRULE_KEYS.join(", ")})`,
        );
    }
  }

  if (freq === undefined) {
    throw new RecurrenceParseError(
      `invalid recurrence rule: ${JSON.stringify(text)} (FREQ required, first)`,
    );
  }
  if (count !== undefined && until !== undefined) {
    throw new RecurrenceParseError(
      `invalid recurrence rule: COUNT and UNTIL are mutually exclusive`,
    );
  }

  const rule: RecurrenceRule = { freq, interval };
  if (byday !== undefined) rule.byday = byday;
  if (bymonthday !== undefined) rule.bymonthday = bymonthday;
  if (count !== undefined) rule.count = count;
  if (until !== undefined) rule.until = until;
  return rule;
}

/** Inclusive ISO day → YYYYMMDD (the UNTIL wire form), fail loud. */
function isoToYmd(iso: string): string {
  let parts: DateParts;
  try {
    parts = parseIsoDate(iso);
  } catch {
    throw new RecurrenceParseError(
      `invalid recurrence rule: until must be a YYYY-MM-DD day, got ${JSON.stringify(iso)}`,
    );
  }
  return partsIso(parts).replaceAll("-", "");
}

/** The canonical stored form: one key order, normalized lists, COUNT|UNTIL. */
export function formatRecurrenceRule(rule: RecurrenceRule): string {
  if (rule.count !== undefined && rule.until !== undefined) {
    throw new RecurrenceParseError(
      `invalid recurrence rule: COUNT and UNTIL are mutually exclusive`,
    );
  }
  const parts = [`FREQ=${rule.freq.toUpperCase()}`];
  if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byday !== undefined && rule.byday.length > 0) {
    parts.push(`BYDAY=${[...rule.byday].sort(weekdayOrder).join(",")}`);
  }
  if (rule.bymonthday !== undefined && rule.bymonthday.length > 0) {
    parts.push(`BYMONTHDAY=${[...rule.bymonthday].sort((a, b) => a - b).join(",")}`);
  }
  if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`);
  else if (rule.until !== undefined) parts.push(`UNTIL=${isoToYmd(rule.until)}`);
  return `${RRULE_PREFIX}${parts.join(";")}`;
}

/**
 * Read the rule out of a Repeat property VALUE (a plain RRULE string; a
 * `{nodeId}` carrier must be resolved to text by the caller before reading).
 * Returns null when the value is absent; a PRESENT but malformed value
 * throws RecurrenceParseError (fail loud — a corrupt rule must never read
 * back as "does not repeat").
 */
export function recurrenceRuleOf(value: unknown): RecurrenceRule | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new RecurrenceParseError(
      `invalid recurrence value: expected an RRULE string (carrier values must be ` +
        `resolved by the caller), got ${JSON.stringify(value)}`,
    );
  }
  return parseRecurrenceRule(value);
}

// --- recurrence exceptions (the Google-calendar semantics) --
//
// Two additive metadata keys on the SAME value that carries the Repeat rule
// (the completedOccurrences precedent — no op, no wire change):
//
//   - `exdates`  — occurrence days removed from the series: a single deleted
//     occurrence, or a day whose occurrence was edited into an exception
//     node (a detached, ordinary non-recurring event).
//   - `until`    — the inclusive last occurrence day; the bound a "this and
//     following" split writes.
//
// Absent/null reads as default (no exceptions / unbounded); a PRESENT but
// malformed value throws — corrupt metadata never reads as "no exceptions".

/** The removed occurrence days (`metadata.exdates`), sorted, deduped. */
export function exdatesOf(metadata: unknown): string[] {
  if (typeof metadata !== "object" || metadata === null) return [];
  const raw = (metadata as Record<string, unknown>).exdates;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      `invalid exdates: expected an array of YYYY-MM-DD dates, got ${JSON.stringify(raw)}`,
    );
  }
  const isos: string[] = [];
  for (const entry of raw) {
    if (!isIsoDay(entry)) {
      throw new Error(
        `invalid exdates entry: ${JSON.stringify(entry)} (expected a YYYY-MM-DD date)`,
      );
    }
    if (!isos.includes(entry)) isos.push(entry);
  }
  return isos.sort();
}

/** The inclusive series bound (`metadata.until`), or null when unbounded. */
export function untilOf(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const raw = (metadata as Record<string, unknown>).until;
  if (raw === undefined || raw === null) return null;
  if (!isIsoDay(raw)) {
    throw new Error(`invalid until: ${JSON.stringify(raw)} (expected a YYYY-MM-DD date)`);
  }
  return raw;
}

/**
 * Assemble the full expansion input: the rule (already read from the Repeat
 * value by the caller) + the exceptions on the value's metadata + the anchor
 * (the driving date value's own day). Null when the node carries no rule.
 * Every exception reader is fail loud, so corrupt metadata throws here —
 * never reads as "plain".
 */
export function recurrenceSeriesOf(
  rule: RecurrenceRule | null,
  metadata: unknown,
  anchorIso: string,
): RecurrenceSeries | null {
  if (rule === null) return null;
  const exdates = exdatesOf(metadata);
  const until = untilOf(metadata);
  return {
    rule,
    anchorIso,
    ...(exdates.length > 0 ? { exdates } : {}),
    ...(until !== null ? { until } : {}),
  };
}

/** `exdates + iso`, sorted — the metadata writer behind "only this event". */
export function withExdate(metadata: unknown, iso: string): Record<string, unknown> {
  if (!isIsoDay(iso)) {
    throw new Error(`invalid occurrence date: ${JSON.stringify(iso)} (expected YYYY-MM-DD)`);
  }
  const base: Record<string, unknown> =
    typeof metadata === "object" && metadata !== null ? { ...(metadata as Record<string, unknown>) } : {};
  const next = [...exdatesOf(metadata), iso].sort();
  base.exdates = next;
  return base;
}

/**
 * The multi-day span end (`metadata.endDate`) — the inclusive last day of a
 * datetime value's range (the value's OWN day is the start; the deferred
 * datetime-range ruling now shipped). Additive metadata like the Repeat
 * exceptions — no op, no wire change. Absent/null reads as null (single-day
 * value); present-but-malformed throws (fail loud). The end day is NOT
 * re-pointed: the value keeps referencing its start day node, and reads
 * expand the span client-side.
 */
export function spanEndOf(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const raw = (metadata as Record<string, unknown>).endDate;
  if (raw === undefined || raw === null) return null;
  if (!isIsoDay(raw)) {
    throw new Error(`invalid endDate: ${JSON.stringify(raw)} (expected a YYYY-MM-DD date)`);
  }
  return raw;
}

/** Set (or clear, null) the inclusive span end. Clearing deletes the key. */
export function withSpanEnd(metadata: unknown, iso: string | null): Record<string, unknown> {
  const base: Record<string, unknown> =
    typeof metadata === "object" && metadata !== null ? { ...(metadata as Record<string, unknown>) } : {};
  if (iso === null) {
    delete base.endDate;
    return base;
  }
  if (!isIsoDay(iso)) {
    throw new Error(`invalid endDate: ${JSON.stringify(iso)} (expected a YYYY-MM-DD)`);
  }
  base.endDate = iso;
  return base;
}

/**
 * Set (or clear, null) the inclusive series bound — the writer behind a
 * "this and following" split. Clearing deletes the key (absent-is-default).
 */
export function withUntil(metadata: unknown, iso: string | null): Record<string, unknown> {
  const base: Record<string, unknown> =
    typeof metadata === "object" && metadata !== null ? { ...(metadata as Record<string, unknown>) } : {};
  if (iso === null) {
    delete base.until;
    return base;
  }
  if (!isIsoDay(iso)) {
    throw new Error(`invalid until: ${JSON.stringify(iso)} (expected a YYYY-MM-DD)`);
  }
  base.until = iso;
  return base;
}

/**
 * Per-occurrence completion: the dates of
 * individually completed occurrences, `metadata.completedOccurrences` on the
 * recurring value — additive metadata like the Repeat rule itself, so no op,
 * no wire change; occurrences stay virtual (no nodes). Absent/null reads as
 * the empty list; a PRESENT but malformed value (not an array of local ISO
 * day strings) throws — corrupt metadata never reads as "nothing completed".
 */
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a syntactically valid, real-calendar local ISO day. */
function isIsoDay(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DAY.test(value)) return false;
  try {
    parseIsoDate(value);
    return true;
  } catch {
    return false;
  }
}

export function completedOccurrencesOf(metadata: unknown): string[] {
  if (typeof metadata !== "object" || metadata === null) return [];
  const raw = (metadata as Record<string, unknown>).completedOccurrences;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      `invalid completedOccurrences: expected an array of YYYY-MM-DD dates, got ${JSON.stringify(raw)}`,
    );
  }
  const isos: string[] = [];
  for (const entry of raw) {
    if (!isIsoDay(entry)) {
      throw new Error(
        `invalid completedOccurrences entry: ${JSON.stringify(entry)} (expected a YYYY-MM-DD date)`,
      );
    }
    if (!isos.includes(entry)) isos.push(entry);
  }
  return isos.sort();
}

/**
 * The metadata for one occurrence-toggle: `iso` joins the list (done) or
 * leaves it (reopen). Every other key (the Repeat rule's exceptions, date
 * qualifiers) rides through untouched — the write replaces the slot's
 * metadata, so the helper never drops what it didn't touch. An empty result
 * clears the key (the grammar's absent-is-default convention).
 */
export function withCompletedOccurrence(
  metadata: unknown,
  iso: string,
  done: boolean,
): Record<string, unknown> {
  if (!isIsoDay(iso)) {
    throw new Error(`invalid occurrence date: ${JSON.stringify(iso)} (expected YYYY-MM-DD)`);
  }
  const base: Record<string, unknown> =
    typeof metadata === "object" && metadata !== null ? { ...(metadata as Record<string, unknown>) } : {};
  const current = completedOccurrencesOf(metadata);
  const next = done ? [...current, iso].sort() : current.filter((entry) => entry !== iso);
  if (next.length === 0) delete base.completedOccurrences;
  else base.completedOccurrences = next;
  return base;
}

// --- legacy grammar → RR5 (the migration converter) -----------------------------

const LEGACY_GRAMMAR = /^(daily|weekly|weekdays|monthly|yearly)(?:\/(\d+))?$/;

/**
 * Convert a retired `<freq>[/<n>]` grammar string to a canonical RRULE,
 * deriving what the bare freqs implied from the anchor day: `weekly` →
 * BYDAY on the anchor's weekday, `weekdays` → BYDAY=MO,TU,WE,TH,FR,
 * `monthly` → BYMONTHDAY on the anchor's day-of-month (`daily`/`yearly`
 * carry no weekday/monthday information). Throws RecurrenceParseError on
 * unknown grammar — the converter is the migration's only legacy reader.
 */
export function legacyRecurrenceToRRule(grammar: string, anchorIso: string): string {
  if (typeof grammar !== "string") {
    throw new RecurrenceParseError(
      `invalid legacy recurrence: expected a string, got ${JSON.stringify(grammar)}`,
    );
  }
  const match = LEGACY_GRAMMAR.exec(grammar.trim());
  if (match === null) {
    throw new RecurrenceParseError(
      `invalid legacy recurrence: ${JSON.stringify(grammar)} ` +
        `(expected <freq> or <freq>/<interval>, freq one of: daily, weekly, weekdays, monthly, yearly)`,
    );
  }
  const freq = match[1];
  const interval = match[2] === undefined ? 1 : Number(match[2]);
  if (interval < 1 || interval > RECURRENCE_MAX_INTERVAL) {
    throw new RecurrenceParseError(
      `invalid legacy recurrence: interval must be 1..${RECURRENCE_MAX_INTERVAL}, got ${JSON.stringify(match[2])}`,
    );
  }
  if (freq === "weekdays" && interval !== 1) {
    throw new RecurrenceParseError(`invalid legacy recurrence: "weekdays" does not take an interval`);
  }
  const anchor = parseIsoDate(anchorIso);
  const rule: RecurrenceRule = { freq: freq === "weekdays" ? "weekly" : (freq as RecurrenceFreq), interval };
  if (freq === "weekly") rule.byday = [weekdayOfParts(anchor)];
  if (freq === "weekdays") rule.byday = [...RECURRENCE_WEEKDAYS.slice(0, 5)];
  if (freq === "monthly") rule.bymonthday = [anchor.day];
  return formatRecurrenceRule(rule);
}

// --- expansion ------------------------------------------------------------------

function partsIso(parts: DateParts): string {
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The month `anchorMonth` + n months shifted (day preserved). */
function shiftMonths(anchor: DateParts, n: number): DateParts {
  const zeroBased = anchor.year * 12 + (anchor.month - 1) + n;
  const year = Math.floor(zeroBased / 12);
  const month = (zeroBased % 12) + 1;
  return { year, month, day: anchor.day };
}

/** Whole UTC days from a to b (b - a), noon-anchored so DST never exists here. */
function dayDiff(a: DateParts, b: DateParts): number {
  const ms =
    Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day);
  return Math.round(ms / 86_400_000);
}

/** Whole months from a to b (b - a). */
function monthDiff(a: DateParts, b: DateParts): number {
  return (b.year - a.year) * 12 + (b.month - a.month);
}

function addDays(parts: DateParts, days: number): DateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

const WEEKDAY_BY_UTCDAY: readonly RecurrenceWeekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function weekdayOfParts(parts: DateParts): RecurrenceWeekday {
  // getUTCDay() is 0..6, so the lookup always hits.
  const index = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return WEEKDAY_BY_UTCDAY[index] as RecurrenceWeekday;
}

/** The two-letter weekday code of an ISO day (UTC — pure calendar arithmetic). */
export function weekdayOfIso(iso: string): RecurrenceWeekday {
  return weekdayOfParts(parseIsoDate(iso));
}

/**
 * Expand a series into the day isos occurring inside the INCLUSIVE window
 * [fromIso, toIso]. Occurrence #1 is the anchor day; every day in
 * [max(anchor, fromIso), toIso] is tested against the RR5 predicate, then
 * filtered by exdates (skip, no index shift), COUNT (index counted from the
 * anchor — occurrences before the window consume indices), and UNTIL
 * (inclusive; the rule's own UNTIL and the metadata bound both apply).
 * At most `cap` occurrences are returned — a window wider than the cap
 * TRUNCATES (callers size the window; the default bounds a daily rule at
 * one year). `fromIso > toIso` throws, as does any malformed date.
 */
export function occurrenceIsosOf(
  series: RecurrenceSeries,
  fromIso: string,
  toIso: string,
  cap: number = RECURRENCE_DEFAULT_CAP,
): string[] {
  if (!Number.isInteger(cap) || cap < 1) {
    throw new Error(`invalid recurrence cap: ${JSON.stringify(cap)} (expected a positive integer)`);
  }
  const anchor = parseIsoDate(series.anchorIso);
  const from = parseIsoDate(fromIso);
  const to = parseIsoDate(toIso);
  if (partsIso(from) > partsIso(to)) {
    throw new Error(`invalid recurrence window: ${fromIso} is after ${toIso}`);
  }
  const out: string[] = [];
  const toPartsIso = partsIso(to);
  const anchorIso = partsIso(anchor);

  // The rule's own end and the exception bound both truncate the series —
  // the earlier one wins. A bounded series whose anchor is past the bound
  // has no occurrences at all.
  const boundIso = [series.until, series.rule.until]
    .filter((u): u is string => u !== undefined)
    .sort()[0] ?? null;
  if (boundIso !== null && anchorIso > boundIso) return out;

  const start = anchorIso > partsIso(from) ? anchor : from;
  if (partsIso(start) > toPartsIso) return out;

  const exdates = series.exdates === undefined ? null : new Set(series.exdates);
  const rule = series.rule;
  const byday =
    rule.byday === undefined || rule.byday.length === 0
      ? null
      : [...rule.byday].sort(weekdayOrder);
  const bymonthday =
    rule.bymonthday === undefined || rule.bymonthday.length === 0
      ? null
      : [...rule.bymonthday].sort((a, b) => a - b);
  const anchorWeekday = weekdayOfParts(anchor);

  /** The RR5 predicate: does `d` (≥ anchor) generate an occurrence? */
  const occursOn = (d: DateParts): boolean => {
    switch (rule.freq) {
      case "daily":
        return dayDiff(anchor, d) % rule.interval === 0;
      case "weekly": {
        const week = Math.floor(dayDiff(anchor, d) / 7);
        if (week % rule.interval !== 0) return false;
        const weekday = weekdayOfParts(d);
        return byday === null ? weekday === anchorWeekday : byday.includes(weekday);
      }
      case "monthly": {
        if (monthDiff(anchor, d) % rule.interval !== 0) return false;
        return bymonthday === null ? d.day === anchor.day : bymonthday.includes(d.day);
      }
      case "yearly":
        return (
          (d.year - anchor.year) % rule.interval === 0 &&
          d.month === anchor.month &&
          d.day === anchor.day
        );
    }
  };

  // COUNT indices count every generated occurrence from the anchor — the
  // occurrences the window skips over consume indices too (a skipped
  // BYMONTHDAY month generates nothing and consumes nothing). Count them in
  // one analytic pass over [anchor, start), then walk the window.
  let seen = countGeneratedBefore(rule, byday, bymonthday, anchor, anchorWeekday, start);

  let current = start;
  for (;;) {
    const iso = partsIso(current);
    if (iso > toPartsIso || out.length >= cap) break;
    if (boundIso !== null && iso > boundIso) break;
    if (occursOn(current)) {
      seen += 1;
      if (rule.count !== undefined && seen > rule.count) break;
      if (exdates === null || !exdates.has(iso)) out.push(iso);
    }
    current = addDays(current, 1);
  }
  return out;
}

/** The number of generated occurrences in [anchor, start) — COUNT bookkeeping. */
function countGeneratedBefore(
  rule: RecurrenceRule,
  byday: readonly RecurrenceWeekday[] | null,
  bymonthday: readonly number[] | null,
  anchor: DateParts,
  anchorWeekday: RecurrenceWeekday,
  start: DateParts,
): number {
  const startIso = partsIso(start);
  const anchorIso = partsIso(anchor);
  switch (rule.freq) {
    case "daily": {
      const diff = dayDiff(anchor, start);
      return diff > 0 ? Math.ceil(diff / rule.interval) : 0;
    }
    case "weekly": {
      const days = byday ?? [anchorWeekday];
      const diff = dayDiff(anchor, start);
      if (diff <= 0) return 0;
      const lastWeek = Math.floor((diff - 1) / 7);
      const weekCount = Math.floor(lastWeek / rule.interval) + 1;
      const anchorPos = RECURRENCE_WEEKDAYS.indexOf(anchorWeekday);
      // Days of `days` in matching week m (n = m·interval) land inside the
      // 7-day block that starts at anchor + 7·m·interval — indexed exactly
      // like occursOn: a BYDAY weekday preceding the anchor's sits AFTER the
      // anchor in block 0 ((pos − anchorPos + 7) % 7), never before it.
      // Only weeks with n % interval === 0 generate, so count the first and
      // last matching weeks day-exact and the full weeks in between at
      // |days| each.
      const countInWeek = (m: number): number => {
        let count = 0;
        for (const b of days) {
          const offset =
            7 * m * rule.interval +
            ((RECURRENCE_WEEKDAYS.indexOf(b) - anchorPos + 7) % 7);
          const iso = partsIso(addDays(anchor, offset));
          if (iso >= anchorIso && iso < startIso) count += 1;
        }
        return count;
      };
      if (weekCount === 1) return countInWeek(0);
      return countInWeek(0) + (weekCount - 2) * days.length + countInWeek(weekCount - 1);
    }
    case "monthly": {
      const days = bymonthday ?? [anchor.day];
      let count = 0;
      for (let j = 0; ; j += rule.interval) {
        const monthStart = shiftMonths({ year: anchor.year, month: anchor.month, day: 1 }, j);
        const dim = daysInMonth(monthStart.year, monthStart.month);
        const lastIso = partsIso({ year: monthStart.year, month: monthStart.month, day: dim });
        const floor = j === 0 ? anchor.day : 1; // month 0: days before the anchor are not generated
        if (lastIso < startIso) {
          for (const x of days) if (x >= floor && x <= dim) count += 1;
          continue;
        }
        for (const x of days) if (x >= floor && x < start.day && x <= dim) count += 1;
        break;
      }
      return count;
    }
    case "yearly": {
      // A Feb 29 anchor generates nothing in a non-leap year — invalid
      // years consume no index and never stop the walk.
      let count = 0;
      for (let y = anchor.year; ; y += rule.interval) {
        if (anchor.day <= daysInMonth(y, anchor.month)) {
          const iso = partsIso({ year: y, month: anchor.month, day: anchor.day });
          if (iso >= startIso) break;
          count += 1;
        }
      }
      return count;
    }
  }
}
