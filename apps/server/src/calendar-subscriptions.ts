/**
 * Calendar subscriptions — ONE-WAY iCal subscribe: the owner points a
 * workspace at an http(s) ICS feed (a Google secret iCal URL, a Nextcloud
 * calendar export, any .ics); the server polls it and ingests VEVENTs as
 * event-classed nodes through the one write path (`ctx.submit`, the capture
 * route's precedent). One-way by design: no write-back, no OAuth — the
 * parked design's "public iCal subscribe" shape.
 *
 * Semantics (documented in docs/features/calendar.md):
 *  - One node per VEVENT UID, id = a deterministic UUIDv5 shape over
 *    (workspace, feed URL, UID) — re-ingest is idempotent (the create
 *    no-ops on the existing node; property.set LWW-updates title/date/rule)
 *    and re-adding the SAME feed after a delete reconverges on the same
 *    nodes. The shared `external_ref` mapping (external-refs.ts — the
 *    designed plugin-runtime service every connection integration reuses)
 *    carries the reverse direction: provenance per node and last-seen per
 *    UID (the base for any future vanished-from-feed handling).
 *  - Times convert into the subscription's configured IANA timezone (the
 *    server's zone by default): all-day DATE values stay day slots; DATE-TIME
 *    values become day + "HH:MM" wall clock. DTEND is exclusive per RFC —
 *    an all-day range's end steps back one day.
 *  - RRULE maps onto the repo's RR5 subset when it fits; an unmappable rule
 *    imports the base event rule-less and the subscription's status says so
 *    (never silently wrong).
 *  - A UID vanishing from the feed NEVER deletes or archives the node — the
 *    feed is additive/updating; graph content is the user's.
 *  - Removing a subscription removes the poller row only; ingested events
 *    stay (they are ordinary nodes now).
 *
 * The subscription rows are coordination state (the shares/prefs ruling —
 * never op-log), stored in relay.db beside the account tables. E2EE
 * workspaces are rejected at the route (no plaintext channel — the capture
 * precedent).
 */

import { createHash } from "node:crypto";

import Database from "better-sqlite3";

import {
  chainNodeIds,
  dateNodeLabel,
  parseIsoDate,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
} from "@notees/domain";

import type { ServerContext } from "./context.js";

// --- storage -----------------------------------------------------------------

export interface CalendarSubscriptionRow {
  id: string;
  workspaceId: string;
  url: string;
  name: string;
  /** IANA zone the feed's times render in (validated at create). */
  timezone: string;
  refreshMinutes: number;
  etag: string | null;
  lastModified: string | null;
  /** Epoch millis of the last fetch attempt; null = never. */
  lastFetchedAt: number | null;
  /** "ok" or a short honest error/warning line from the last refresh. */
  lastStatus: string | null;
  createdAt: number;
}

interface RawRow {
  id: string;
  workspace_id: string;
  url: string;
  name: string;
  timezone: string;
  refresh_minutes: number;
  etag: string | null;
  last_modified: string | null;
  last_fetched_at: number | null;
  last_status: string | null;
  created_at: number;
}

const DDL = `
CREATE TABLE IF NOT EXISTS calendar_subscription (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    url TEXT NOT NULL,
    name TEXT NOT NULL,
    timezone TEXT NOT NULL,
    refresh_minutes INTEGER NOT NULL DEFAULT 60,
    etag TEXT,
    last_modified TEXT,
    last_fetched_at INTEGER,
    last_status TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_subscription_workspace ON calendar_subscription (workspace_id);
`;

/** The calendar consumer's namespace in the shared external-ref mapping
 *  (external-refs.ts): keyed by the feed URL — stable across subscription
 *  delete/re-add, matching the node-id derivation. */
export function calendarIntegrationKey(feedUrl: string): string {
  return `calendar:${feedUrl}`;
}

function toRow(raw: RawRow): CalendarSubscriptionRow {
  return {
    id: raw.id,
    workspaceId: raw.workspace_id,
    url: raw.url,
    name: raw.name,
    timezone: raw.timezone,
    refreshMinutes: raw.refresh_minutes,
    etag: raw.etag,
    lastModified: raw.last_modified,
    lastFetchedAt: raw.last_fetched_at,
    lastStatus: raw.last_status,
    createdAt: raw.created_at,
  };
}

/** The subscription store rides relay.db (the shares precedent: its own
 *  connection beside the account tables, WAL + busy timeout). */
export class CalendarSubscriptionStorage {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(DDL);
  }

  close(): void {
    this.db.close();
  }

  create(input: {
    id: string;
    workspaceId: string;
    url: string;
    name: string;
    timezone: string;
    refreshMinutes: number;
  }): CalendarSubscriptionRow {
    this.db
      .prepare(
        `INSERT INTO calendar_subscription
           (id, workspace_id, url, name, timezone, refresh_minutes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.workspaceId,
        input.url,
        input.name,
        input.timezone,
        input.refreshMinutes,
        Date.now(),
      );
    return this.get(input.id)!;
  }

  get(id: string): CalendarSubscriptionRow | undefined {
    const raw = this.db
      .prepare("SELECT * FROM calendar_subscription WHERE id = ?")
      .get(id) as RawRow | undefined;
    return raw === undefined ? undefined : toRow(raw);
  }

  list(workspaceId: string): CalendarSubscriptionRow[] {
    return (
      this.db
        .prepare("SELECT * FROM calendar_subscription WHERE workspace_id = ? ORDER BY created_at")
        .all(workspaceId) as RawRow[]
    ).map(toRow);
  }

  listAll(): CalendarSubscriptionRow[] {
    return (
      this.db.prepare("SELECT * FROM calendar_subscription ORDER BY created_at").all() as RawRow[]
    ).map(toRow);
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM calendar_subscription WHERE id = ?").run(id).changes > 0;
  }

  recordFetch(
    id: string,
    patch: { etag?: string | null; lastModified?: string | null; status: string },
  ): void {
    this.db
      .prepare(
        `UPDATE calendar_subscription
           SET last_fetched_at = ?, last_status = ?,
               etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified)
         WHERE id = ?`,
      )
      .run(Date.now(), patch.status, patch.etag ?? null, patch.lastModified ?? null, id);
  }
}

// --- ICS parsing (minimal VEVENT reader, fail-loud) ----------------------------

export interface IcsDateValue {
  kind: "date" | "datetime";
  /** "YYYYMMDD" for date; "YYYYMMDDTHHMMSS" (+zulu flag) for datetime. */
  value: string;
  zulu: boolean;
  tzid: string | null;
}

export interface IcsEvent {
  uid: string;
  summary: string;
  start: IcsDateValue;
  end: IcsDateValue | null;
  rrule: string | null;
}

/** Unfold folded ICS lines (CRLF + space/tab continuation) into logical lines. */
function unfoldLines(text: string): string[] {
  const physical = text.split(/\r\n|\n|\r/);
  const logical: string[] = [];
  for (const line of physical) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && logical.length > 0) {
      logical[logical.length - 1] += line.slice(1);
    } else {
      logical.push(line);
    }
  }
  return logical;
}

function parseDateValue(raw: string, params: Map<string, string>): IcsDateValue | null {
  const value = raw.trim();
  const tzid = params.get("TZID") ?? null;
  if (/^\d{8}$/.test(value)) return { kind: "date", value, zulu: false, tzid: null };
  const dt = value.match(/^(\d{8}T\d{6})(Z?)$/);
  if (dt !== null) return { kind: "datetime", value: dt[1]!, zulu: dt[2] === "Z", tzid };
  return null;
}

/**
 * Parse the feed's VEVENTs. Malformed EVENTS are skipped and counted (one
 * broken event never kills a feed); a body that is not an iCalendar stream
 * at all throws (fail loud at the subscription level).
 */
export function parseIcsEvents(text: string): { events: IcsEvent[]; skipped: number } {
  const lines = unfoldLines(text);
  if (!lines.some((line) => line.trim() === "BEGIN:VCALENDAR")) {
    throw new Error("not an iCalendar stream (no BEGIN:VCALENDAR)");
  }
  const events: IcsEvent[] = [];
  let skipped = 0;
  let current: Partial<IcsEvent> | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (trimmed === "END:VEVENT") {
      if (current?.uid !== undefined && current.start !== undefined) {
        events.push({
          uid: current.uid,
          summary: current.summary ?? "(untitled event)",
          start: current.start,
          end: current.end ?? null,
          rrule: current.rrule ?? null,
        });
      } else {
        skipped += 1;
      }
      current = null;
      continue;
    }
    if (current === null) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const head = trimmed.slice(0, colon);
    const value = trimmed.slice(colon + 1);
    const [name, ...paramParts] = head.split(";");
    const params = new Map<string, string>();
    for (const part of paramParts) {
      const eq = part.indexOf("=");
      if (eq > 0) params.set(part.slice(0, eq).toUpperCase(), part.slice(eq + 1));
    }
    switch (name!.toUpperCase()) {
      case "UID":
        current.uid = value.trim();
        break;
      case "SUMMARY":
        current.summary = value.trim();
        break;
      case "DTSTART": {
        const parsed = parseDateValue(value, params);
        if (parsed !== null) current.start = parsed;
        break;
      }
      case "DTEND": {
        const parsed = parseDateValue(value, params);
        if (parsed !== null) current.end = parsed;
        break;
      }
      case "RRULE":
        current.rrule = value.trim();
        break;
    }
  }
  return { events, skipped };
}

// --- timezone math (Intl only, no dependency) -----------------------------------

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    zoneFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall clock ({dayIso, time}) of a UTC instant in an IANA zone. */
export function wallClockInZone(utcMs: number, timeZone: string): { dayIso: string; time: string } {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(utcMs));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    dayIso: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${hour}:${get("minute")}`,
  };
}

/**
 * A wall time authored in an IANA zone → the UTC instant. Two-pass offset
 * correction: guess the instant as-if-UTC, read the zone's offset there,
 * adjust, and re-check once (DST edges).
 */
export function zonedWallToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (ms: number): number => {
    const wall = wallClockInZone(ms, timeZone);
    const [y, mo, d] = wall.dayIso.split("-").map(Number);
    const [h, mi] = wall.time.split(":").map(Number);
    return Date.UTC(y!, mo! - 1, d!, h!, mi!) - ms;
  };
  let guess = target - offsetAt(target);
  guess = target - offsetAt(guess);
  return guess;
}

/** One ICS date value → the wall clock in the subscription's zone. */
export function icsValueToWallClock(
  value: IcsDateValue,
  feedZone: string,
): { dayIso: string; time: string | null } {
  if (value.kind === "date") {
    const y = Number(value.value.slice(0, 4));
    const m = Number(value.value.slice(4, 6));
    const d = Number(value.value.slice(6, 8));
    return { dayIso: `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, time: null };
  }
  const y = Number(value.value.slice(0, 4));
  const mo = Number(value.value.slice(4, 6));
  const d = Number(value.value.slice(6, 8));
  const h = Number(value.value.slice(9, 11));
  const mi = Number(value.value.slice(11, 13));
  // A Z time is a UTC instant; a floating/TZID time is wall clock in the
  // event's own zone (TZID) or — floating — the subscription's zone.
  const utcMs = value.zulu
    ? Date.UTC(y, mo - 1, d, h, mi)
    : zonedWallToUtcMs(y, mo, d, h, mi, value.tzid ?? feedZone);
  const wall = wallClockInZone(utcMs, feedZone);
  return { dayIso: wall.dayIso, time: wall.time };
}

// --- RRULE mapping (the repo's RR5 subset) --------------------------------------

const ICS_WEEKDAYS = new Set(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);

/**
 * Map an ICS RRULE onto the repo's canonical RRULE string when it fits the
 * RR5 subset (FREQ daily/weekly/monthly/yearly + INTERVAL/BYDAY/BYMONTHDAY/
 * COUNT/UNTIL). Returns null when the rule uses anything outside the subset
 * (the caller imports the base event rule-less and says so).
 */
export function icsRruleToCanonical(rrule: string): string | null {
  const parts = new Map<string, string>();
  for (const piece of rrule.split(";")) {
    const eq = piece.indexOf("=");
    if (eq <= 0) return null;
    parts.set(piece.slice(0, eq).toUpperCase(), piece.slice(eq + 1));
  }
  const freq = parts.get("FREQ")?.toUpperCase();
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") {
    return null;
  }
  const out: string[] = [`FREQ=${freq}`];
  for (const [key, value] of parts) {
    switch (key) {
      case "FREQ":
        break;
      case "INTERVAL":
        if (!/^\d+$/.test(value)) return null;
        out.push(`INTERVAL=${value}`);
        break;
      case "BYDAY":
        if (freq !== "WEEKLY") return null;
        if (!value.split(",").every((day) => ICS_WEEKDAYS.has(day.toUpperCase()))) return null;
        out.push(`BYDAY=${value.toUpperCase()}`);
        break;
      case "BYMONTHDAY":
        if (!value.split(",").every((day) => /^-?\d+$/.test(day))) return null;
        out.push(`BYMONTHDAY=${value}`);
        break;
      case "COUNT":
        if (!/^\d+$/.test(value)) return null;
        out.push(`COUNT=${value}`);
        break;
      case "UNTIL": {
        const until = value.match(/^(\d{4})(\d{2})(\d{2})(T\d{6}Z?)?$/);
        if (until === null) return null;
        out.push(`UNTIL=${until[1]}-${until[2]}-${until[3]}`);
        break;
      }
      default:
        // WKST is harmless presentation; anything else leaves the subset.
        if (key !== "WKST") return null;
    }
  }
  return `RRULE:${out.join(";")}`;
}

// --- ingest ---------------------------------------------------------------------

/** Deterministic node id: UUIDv5-shaped (sha1, version/variant bits) over
 *  the workspace + feed URL + event UID — re-ingest converges on the same
 *  node, and re-adding the SAME feed after a delete reconverges too (the
 *  subscription row's own id deliberately does NOT feed the derivation).
 *  The calendar_event_map table carries the reverse/provenance direction. */
export function eventNodeId(workspaceId: string, feedUrl: string, uid: string): string {
  const hash = createHash("sha1").update(`${workspaceId}/${feedUrl}/${uid}`).digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Ensure the date chain (year → month → day) exists for a day (the capture route's shape). */
async function ensureDayChain(ctx: ServerContext, workspaceId: string, dayIso: string): Promise<string> {
  const chain = chainNodeIds(dayIso);
  const store = ctx.workspaces.storeFor(workspaceId);
  const exists = (id: string): boolean =>
    store.database.prepare("SELECT 1 FROM node WHERE id = ?").get(id) !== undefined;
  const parts = parseIsoDate(dayIso);
  const levels: Array<{ id: string; precision: "year" | "month" | "day"; classId: string }> = [
    { id: chain.year, precision: "year", classId: SYSTEM_CLASS_UUIDS.year },
    { id: chain.month, precision: "month", classId: SYSTEM_CLASS_UUIDS.month },
    { id: chain.day, precision: "day", classId: SYSTEM_CLASS_UUIDS.day },
  ];
  for (const level of levels) {
    if (exists(level.id)) continue;
    await ctx.submit({
      workspaceId,
      opType: "object.create",
      payload: {
        objectId: level.id,
        parentId: level.precision === "year" ? null : level.precision === "month" ? chain.year : chain.month,
        isEmbedded: false,
        classIds: [level.classId],
        contentAst: [{ type: "text", text: dateNodeLabel(parts, level.precision) }],
      },
      affectedNodeIds: [level.id],
      client: "calendar-subscribe",
    });
  }
  return chain.day;
}

export interface IngestResult {
  created: number;
  updated: number;
  skipped: number;
  ruleless: number;
}

/**
 * Ingest one fetched feed: one event-classed node per VEVENT (idempotent by
 * the deterministic id — the create no-ops on re-ingest, the property sets
 * LWW-update). The workspace must be seeded (the route/poller ensure it).
 */
export async function ingestFeed(
  ctx: ServerContext,
  subscription: CalendarSubscriptionRow,
  icsText: string,
): Promise<IngestResult> {
  const { events, skipped } = parseIcsEvents(icsText);
  const store = ctx.workspaces.storeFor(subscription.workspaceId);
  const result: IngestResult = { created: 0, updated: 0, skipped, ruleless: 0 };

  for (const event of events) {
    const start = icsValueToWallClock(event.start, subscription.timezone);
    const nodeId = eventNodeId(subscription.workspaceId, subscription.url, event.uid);
    // The shared external-ref mapping (external-refs.ts): provenance +
    // last-seen for this UID; the node id itself is derivable, so the map
    // is the reverse direction, never the only copy.
    ctx.externalRefs.record({
      workspaceId: subscription.workspaceId,
      integration: calendarIntegrationKey(subscription.url),
      externalId: event.uid,
      nodeId,
    });
    const existing = store.database
      .prepare("SELECT content FROM node WHERE id = ?")
      .get(nodeId) as { content: string } | undefined;
    await ensureDayChain(ctx, subscription.workspaceId, start.dayIso);
    await ctx.submit({
      workspaceId: subscription.workspaceId,
      opType: "object.create",
      payload: {
        objectId: nodeId,
        parentId: null,
        isEmbedded: false,
        classIds: [SYSTEM_CLASS_UUIDS.event],
        contentAst: [{ type: "text", text: event.summary }],
      },
      affectedNodeIds: [nodeId],
      client: "calendar-subscribe",
    });
    // First-create-wins for content (the applier's re-create contract), so
    // a feed RENAME rides an explicit LWW update — the feed is the authority
    // for its own events (a local rename is overwritten on the next
    // refresh; documented). Only a real difference writes.
    if (existing !== undefined) {
      let currentTitle: string | null = null;
      try {
        const tokens = JSON.parse(existing.content) as Array<{ type?: string; text?: string }>;
        if (Array.isArray(tokens) && tokens.length === 1 && tokens[0]?.type === "text") {
          currentTitle = tokens[0].text ?? null;
        }
      } catch {
        currentTitle = null;
      }
      if (currentTitle !== event.summary) {
        await ctx.submit({
          workspaceId: subscription.workspaceId,
          opType: "object.update",
          payload: {
            objectId: nodeId,
            contentAst: [{ type: "text", text: event.summary }],
          },
          affectedNodeIds: [nodeId],
          client: "calendar-subscribe",
        });
      }
    }
    const setProp = (propertySchemaId: string, value: unknown) =>
      ctx.submit({
        workspaceId: subscription.workspaceId,
        opType: "property.set",
        payload: { objectId: nodeId, propertySchemaId, value },
        affectedNodeIds: [nodeId],
        client: "calendar-subscribe",
      });

    // The date value: an all-day multi-day event maps to a RANGE (DTEND is
    // exclusive per RFC — the end steps back one day); a timed event maps to
    // the day + wall-clock point.
    if (event.end !== null && event.end.kind === "date" && event.start.kind === "date") {
      const end = icsValueToWallClock(event.end, subscription.timezone);
      const endMs = Date.UTC(
        Number(end.dayIso.slice(0, 4)),
        Number(end.dayIso.slice(5, 7)) - 1,
        Number(end.dayIso.slice(8, 10)),
      ) - 24 * 60 * 60 * 1000;
      const endIso = new Date(endMs).toISOString().slice(0, 10);
      if (endIso > start.dayIso) {
        await ensureDayChain(ctx, subscription.workspaceId, endIso);
        await setProp(SYSTEM_PROPERTY_UUIDS.eventDate, {
          start: { nodeId: chainNodeIds(start.dayIso).day },
          end: { nodeId: chainNodeIds(endIso).day },
        });
      } else {
        await setProp(SYSTEM_PROPERTY_UUIDS.eventDate, {
          nodeId: chainNodeIds(start.dayIso).day,
        });
      }
    } else {
      await setProp(SYSTEM_PROPERTY_UUIDS.eventDate, {
        nodeId: chainNodeIds(start.dayIso).day,
        ...(start.time !== null ? { time: start.time } : {}),
      });
    }

    if (event.rrule !== null) {
      const canonical = icsRruleToCanonical(event.rrule);
      if (canonical !== null) {
        await setProp(SYSTEM_PROPERTY_UUIDS.repeat, canonical);
      } else {
        result.ruleless += 1;
      }
    }
    if (existing !== undefined) result.updated += 1;
    else result.created += 1;
  }
  return result;
}

// --- fetching + the poller --------------------------------------------------------

const FETCH_TIMEOUT_MS = 15_000;
const MAX_FEED_BYTES = 5 * 1024 * 1024;

export interface FetchOutcome {
  /** null = not-modified (304). */
  body: string | null;
  etag: string | null;
  lastModified: string | null;
}

/** Conditional GET of the feed; injectable for tests. */
export async function fetchIcs(
  url: string,
  conditional: { etag: string | null; lastModified: string | null },
): Promise<FetchOutcome> {
  const headers: Record<string, string> = { accept: "text/calendar, text/plain, */*" };
  if (conditional.etag !== null) headers["if-none-match"] = conditional.etag;
  if (conditional.lastModified !== null) headers["if-modified-since"] = conditional.lastModified;
  const response = await fetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status === 304) {
    return { body: null, etag: conditional.etag, lastModified: conditional.lastModified };
  }
  if (!response.ok) {
    throw new Error(`feed answered HTTP ${response.status}`);
  }
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_FEED_BYTES) throw new Error("feed exceeds the 5 MiB cap");
  const body = await response.text();
  if (body.length > MAX_FEED_BYTES) throw new Error("feed exceeds the 5 MiB cap");
  return {
    body,
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}

/** One refresh of one subscription: fetch (conditional) + ingest + status. */
export async function refreshSubscription(
  ctx: ServerContext,
  subscription: CalendarSubscriptionRow,
  fetcher: typeof fetchIcs = fetchIcs,
): Promise<string> {
  await ctx.ensureSeeded(subscription.workspaceId);
  try {
    const outcome = await fetcher(subscription.url, {
      etag: subscription.etag,
      lastModified: subscription.lastModified,
    });
    if (outcome.body === null) {
      ctx.calendars.recordFetch(subscription.id, { status: "ok (not modified)" });
      return "ok (not modified)";
    }
    const result = await ingestFeed(ctx, subscription, outcome.body);
    const status =
      `ok — ${result.created} new, ${result.updated} updated` +
      (result.skipped > 0 ? `, ${result.skipped} skipped (malformed)` : "") +
      (result.ruleless > 0 ? `, ${result.ruleless} without rule (unsupported RRULE)` : "");
    ctx.calendars.recordFetch(subscription.id, {
      etag: outcome.etag,
      lastModified: outcome.lastModified,
      status,
    });
    return status;
  } catch (error) {
    const status = `error: ${error instanceof Error ? error.message : String(error)}`;
    ctx.calendars.recordFetch(subscription.id, { status });
    return status;
  }
}

/** The polling sweep: every minute, refresh the subscriptions whose interval
 *  has elapsed. Started by app.ts; stopped on close. */
export class CalendarPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly ctx: ServerContext,
    private readonly intervalMs = 60_000,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(fetcher: typeof fetchIcs = fetchIcs): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      for (const subscription of this.ctx.calendars.listAll()) {
        const dueAt = (subscription.lastFetchedAt ?? 0) + subscription.refreshMinutes * 60_000;
        if (dueAt > now) continue;
        await refreshSubscription(this.ctx, subscription, fetcher);
      }
    } finally {
      this.running = false;
    }
  }
}
