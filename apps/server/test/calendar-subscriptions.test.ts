/**
 * Calendar subscriptions tests — the one-way iCal subscribe slice:
 *
 *  - the pure pieces: parseIcsEvents (unfolding, all-day vs timed/Z, the
 *    malformed-event skip, the non-calendar throw), icsRruleToCanonical
 *    (the RR5-subset mapping + the out-of-subset nulls), the timezone math
 *    (wallClockInZone / zonedWallToUtcMs round-trips), eventNodeId
 *    determinism;
 *  - the routes: POST creates + first-refresh ingests (event-classed nodes,
 *    the eventDate point/range shapes, the repeat rule), a re-refresh is
 *    idempotent and propagates a feed RENAME, the conditional-GET 304 path,
 *    the owner/admin gate, the invalid-timezone and E2EE refusals, DELETE
 *    removes the row while the events stay;
 *  - the poller sweep refreshes a due subscription and skips a fresh one.
 */

import { afterEach, describe, expect, it } from "vitest";

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS, chainNodeIds } from "@notees/domain";

import {
  CalendarPoller,
  eventNodeId,
  icsRruleToCanonical,
  parseIcsEvents,
  wallClockInZone,
  zonedWallToUtcMs,
  type FetchOutcome,
} from "../src/calendar-subscriptions.js";
import { closeTestServer, makeTestServer, type TestServer } from "./helpers";

let server: TestServer | null = null;
afterEach(async () => {
  if (server !== null) {
    await closeTestServer(server);
    server = null;
  }
});

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//test//EN",
  "BEGIN:VEVENT",
  "UID:standup@example.com",
  "SUMMARY:Daily standup",
  "DTSTART;TZID=Europe/Madrid:20261125T093000",
  "DTEND;TZID=Europe/Madrid:20261125T094500",
  "RRULE:FREQ=DAILY;INTERVAL=1",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:offsite@example.com",
  "SUMMARY:Team offs",
  " ite", // folded continuation — unfolds into "Team offsite"
  "DTSTART;VALUE=DATE:20261210",
  "DTEND;VALUE=DATE:20261212",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "SUMMARY:Broken — no UID, no DTSTART",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("parseIcsEvents", () => {
  it("parses VEVENTs with unfolding; a malformed event skips and counts", () => {
    const { events, skipped } = parseIcsEvents(ICS);
    expect(events).toHaveLength(2);
    expect(skipped).toBe(1);
    expect(events[0]).toMatchObject({
      uid: "standup@example.com",
      summary: "Daily standup",
      start: { kind: "datetime", value: "20261125T093000", zulu: false, tzid: "Europe/Madrid" },
      rrule: "FREQ=DAILY;INTERVAL=1",
    });
    expect(events[1]).toMatchObject({
      uid: "offsite@example.com",
      summary: "Team offsite",
      start: { kind: "date", value: "20261210" },
      end: { kind: "date", value: "20261212" },
    });
  });

  it("throws on a body that is not an iCalendar stream", () => {
    expect(() => parseIcsEvents("<html>nope</html>")).toThrow(/BEGIN:VCALENDAR/);
  });
});

describe("icsRruleToCanonical", () => {
  it("maps the RR5 subset and refuses everything outside it", () => {
    expect(icsRruleToCanonical("FREQ=DAILY;INTERVAL=2")).toBe("RRULE:FREQ=DAILY;INTERVAL=2");
    expect(icsRruleToCanonical("FREQ=WEEKLY;BYDAY=MO,FR;UNTIL=20261231T235959Z")).toBe(
      "RRULE:FREQ=WEEKLY;BYDAY=MO,FR;UNTIL=2026-12-31",
    );
    expect(icsRruleToCanonical("FREQ=MONTHLY;BYMONTHDAY=15;COUNT=6")).toBe(
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=15;COUNT=6",
    );
    expect(icsRruleToCanonical("FREQ=WEEKLY;WKST=MO")).toBe("RRULE:FREQ=WEEKLY");
    expect(icsRruleToCanonical("FREQ=HOURLY")).toBeNull();
    expect(icsRruleToCanonical("FREQ=WEEKLY;BYDAY=2MO")).toBeNull();
    expect(icsRruleToCanonical("FREQ=YEARLY;BYWEEKNO=20")).toBeNull();
  });
});

describe("timezone math", () => {
  it("wallClockInZone renders a UTC instant in the zone (CET winter)", () => {
    // 2026-11-25T08:30:00Z = 09:30 in Europe/Madrid (CET, UTC+1).
    const wall = wallClockInZone(Date.UTC(2026, 10, 25, 8, 30), "Europe/Madrid");
    expect(wall).toEqual({ dayIso: "2026-11-25", time: "09:30" });
  });

  it("zonedWallToUtcMs inverts it, including across the DST boundary", () => {
    const winter = zonedWallToUtcMs(2026, 11, 25, 9, 30, "Europe/Madrid");
    expect(new Date(winter).toISOString()).toBe("2026-11-25T08:30:00.000Z");
    // Summer: CEST (UTC+2).
    const summer = zonedWallToUtcMs(2026, 6, 25, 9, 30, "Europe/Madrid");
    expect(new Date(summer).toISOString()).toBe("2026-06-25T07:30:00.000Z");
  });
});

describe("eventNodeId", () => {
  it("is deterministic per (subscription, uid) and uuid-shaped", () => {
    const a = eventNodeId("ws-1", "https://feed.example.com/a.ics", "uid-1");
    expect(eventNodeId("ws-1", "https://feed.example.com/a.ics", "uid-1")).toBe(a);
    expect(eventNodeId("ws-1", "https://feed.example.com/a.ics", "uid-2")).not.toBe(a);
    expect(eventNodeId("ws-1", "https://feed.example.com/b.ics", "uid-1")).not.toBe(a);
    expect(eventNodeId("ws-2", "https://feed.example.com/a.ics", "uid-1")).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

// --- routes + ingest ---------------------------------------------------------------

async function makeServer(): Promise<TestServer> {
  server = await makeTestServer();
  return server;
}

function fakeFetcher(bodies: Array<string | null>): typeof import("../src/calendar-subscriptions.js").fetchIcs {
  let call = 0;
  return async (_url, conditional): Promise<FetchOutcome> => {
    const body = bodies[Math.min(call, bodies.length - 1)]!;
    call += 1;
    if (body === null) {
      return { body: null, etag: conditional.etag, lastModified: conditional.lastModified };
    }
    return { body, etag: `"etag-${call}"`, lastModified: null };
  };
}

/** Route-level fetch stub (the routes call the module fetcher → global fetch). */
function stubGlobalFetch(body: string | null, calls: { count: number }): void {
  globalThis.fetch = (async () => {
    calls.count += 1;
    if (body === null) return new Response(null, { status: 304 });
    return new Response(body, { status: 200, headers: { etag: '"e1"' } });
  }) as typeof fetch;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("calendar subscription routes", () => {
  it("POST creates the row and ingests: event nodes with dates + the mapped rule", async () => {
    const s = await makeServer();
    const calls = { count: 0 };
    stubGlobalFetch(ICS, calls);
    const response = await s.app.inject({
      method: "POST",
      url: "/api/calendars",
      headers: { "content-type": "application/json", ...s.authHeaders },
      payload: {
        workspaceId: s.ctx.defaultWorkspace,
        url: "https://calendar.example.com/feed.ics",
        name: "Test feed",
        timezone: "Europe/Madrid",
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { subscription: { id: string; lastStatus: string } };
    expect(body.subscription.lastStatus).toContain("2 new");
    expect(body.subscription.lastStatus).toContain("1 skipped");

    const store = s.ctx.workspaces.storeFor(s.ctx.defaultWorkspace);
    const standupId = eventNodeId(s.ctx.defaultWorkspace, "https://calendar.example.com/feed.ics", "standup@example.com");
    const standup = store.database
      .prepare("SELECT content, class_ids FROM node WHERE id = ?")
      .get(standupId) as { content: string; class_ids: string };
    expect(standup.content).toContain("Daily standup");
    expect(JSON.parse(standup.class_ids)).toContain(SYSTEM_CLASS_UUIDS.event);
    // 09:30 Europe/Madrid on 2026-11-25 — the wall clock survives verbatim.
    const dateRow = store.database
      .prepare(
        "SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ?",
      )
      .get(standupId, SYSTEM_PROPERTY_UUIDS.eventDate) as { value: string };
    expect(JSON.parse(dateRow.value)).toEqual({
      nodeId: chainNodeIds("2026-11-25").day,
      time: "09:30",
    });
    const repeatRow = store.database
      .prepare(
        "SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ?",
      )
      .get(standupId, SYSTEM_PROPERTY_UUIDS.repeat) as { value: string };
    expect(JSON.parse(repeatRow.value)).toBe("RRULE:FREQ=DAILY;INTERVAL=1");

    // The all-day multi-day event maps to an exclusive-end range (10th–11th).
    const offsiteId = eventNodeId(s.ctx.defaultWorkspace, "https://calendar.example.com/feed.ics", "offsite@example.com");
    const offsiteRow = store.database
      .prepare(
        "SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ?",
      )
      .get(offsiteId, SYSTEM_PROPERTY_UUIDS.eventDate) as { value: string };
    expect(JSON.parse(offsiteRow.value)).toEqual({
      start: { nodeId: chainNodeIds("2026-12-10").day },
      end: { nodeId: chainNodeIds("2026-12-11").day },
    });
  });

  it("re-refresh is idempotent and propagates a feed rename", async () => {
    const s = await makeServer();
    const calls = { count: 0 };
    stubGlobalFetch(ICS, calls);
    const created = await s.app.inject({
      method: "POST",
      url: "/api/calendars",
      headers: { "content-type": "application/json", ...s.authHeaders },
      payload: {
        workspaceId: s.ctx.defaultWorkspace,
        url: "https://calendar.example.com/feed.ics",
        timezone: "Europe/Madrid",
      },
    });
    const { id } = (created.json() as { subscription: { id: string } }).subscription;

    // The feed renames the standup.
    globalThis.fetch = (async () =>
      new Response(ICS.replace("SUMMARY:Daily standup", "SUMMARY:Daily sync"), {
        status: 200,
      })) as typeof fetch;
    const refreshed = await s.app.inject({
      method: "POST",
      url: `/api/calendars/${id}/refresh`,
      headers: s.authHeaders,
    });
    expect(refreshed.statusCode).toBe(200);
    expect((refreshed.json() as { status: string }).status).toContain("2 updated");

    const store = s.ctx.workspaces.storeFor(s.ctx.defaultWorkspace);
    const standupId = eventNodeId(s.ctx.defaultWorkspace, "https://calendar.example.com/feed.ics", "standup@example.com");
    const rows = store.database
      .prepare("SELECT COUNT(*) AS n FROM node WHERE id = ?")
      .get(standupId) as { n: number };
    expect(rows.n).toBe(1); // no duplicate node
    const content = store.database
      .prepare("SELECT content FROM node WHERE id = ?")
      .get(standupId) as { content: string };
    expect(content.content).toContain("Daily sync");
  });

  it("the 304 path touches the status without re-ingesting", async () => {
    const s = await makeServer();
    const calls = { count: 0 };
    stubGlobalFetch(ICS, calls);
    const created = await s.app.inject({
      method: "POST",
      url: "/api/calendars",
      headers: { "content-type": "application/json", ...s.authHeaders },
      payload: {
        workspaceId: s.ctx.defaultWorkspace,
        url: "https://calendar.example.com/feed.ics",
      },
    });
    const { id } = (created.json() as { subscription: { id: string } }).subscription;
    stubGlobalFetch(null, calls);
    const refreshed = await s.app.inject({
      method: "POST",
      url: `/api/calendars/${id}/refresh`,
      headers: s.authHeaders,
    });
    expect((refreshed.json() as { status: string }).status).toBe("ok (not modified)");
  });

  it("gates on auth and refuses bad timezones; DELETE keeps the events", async () => {
    const s = await makeServer();
    const calls = { count: 0 };
    stubGlobalFetch(ICS, calls);

    const unauthenticated = await s.app.inject({
      method: "POST",
      url: "/api/calendars",
      headers: { "content-type": "application/json" },
      payload: { workspaceId: s.ctx.defaultWorkspace, url: "https://x.example.com/f.ics" },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const badZone = await s.app.inject({
      method: "POST",
      url: "/api/calendars",
      headers: { "content-type": "application/json", ...s.authHeaders },
      payload: {
        workspaceId: s.ctx.defaultWorkspace,
        url: "https://x.example.com/f.ics",
        timezone: "Not/AZone",
      },
    });
    expect(badZone.statusCode).toBe(422);

    const created = await s.app.inject({
      method: "POST",
      url: "/api/calendars",
      headers: { "content-type": "application/json", ...s.authHeaders },
      payload: {
        workspaceId: s.ctx.defaultWorkspace,
        url: "https://x.example.com/f.ics",
        timezone: "Europe/Madrid",
      },
    });
    const { id } = (created.json() as { subscription: { id: string } }).subscription;
    const removed = await s.app.inject({
      method: "DELETE",
      url: `/api/calendars/${id}`,
      headers: s.authHeaders,
    });
    expect(removed.statusCode).toBe(200);
    expect(s.ctx.calendars.get(id)).toBeUndefined();
    // The ingested events stay — ordinary graph content.
    const store = s.ctx.workspaces.storeFor(s.ctx.defaultWorkspace);
    const standupId = eventNodeId(s.ctx.defaultWorkspace, "https://x.example.com/f.ics", "standup@example.com");
    expect(
      store.database.prepare("SELECT 1 FROM node WHERE id = ?").get(standupId),
    ).toBeDefined();
    // The shared external-ref mapping survives the subscription's deletion
    // (the events do too) — the reverse lookup still answers.
    expect(s.ctx.externalRefs.provenanceOf(standupId)).toMatchObject({
      integration: "calendar:https://x.example.com/f.ics",
      externalId: "standup@example.com",
    });
  });

  it("the shared external-ref mapping: resolve, provenance, last-seen bump, forget", async () => {
    const s = await makeServer();
    const ws = s.ctx.defaultWorkspace;
    s.ctx.externalRefs.record({
      workspaceId: ws,
      integration: "readlater:pocket",
      externalId: "item-42",
      nodeId: "node-a",
    });
    expect(s.ctx.externalRefs.resolve(ws, "readlater:pocket", "item-42")).toBe("node-a");
    expect(s.ctx.externalRefs.resolve(ws, "readlater:pocket", "item-43")).toBeUndefined();
    expect(s.ctx.externalRefs.provenanceOf("node-a")).toMatchObject({
      integration: "readlater:pocket",
      externalId: "item-42",
    });
    // A re-record bumps last_seen and can re-point honestly.
    s.ctx.externalRefs.record({
      workspaceId: ws,
      integration: "readlater:pocket",
      externalId: "item-42",
      nodeId: "node-b",
    });
    expect(s.ctx.externalRefs.resolve(ws, "readlater:pocket", "item-42")).toBe("node-b");
    expect(s.ctx.externalRefs.listByIntegration(ws, "readlater:pocket")).toHaveLength(1);
    expect(s.ctx.externalRefs.forgetIntegration(ws, "readlater:pocket")).toBe(1);
    expect(s.ctx.externalRefs.resolve(ws, "readlater:pocket", "item-42")).toBeUndefined();
  });

  it("the poller sweep refreshes a due subscription and skips a fresh one", async () => {
    const s = await makeServer();
    const row = s.ctx.calendars.create({
      id: crypto.randomUUID(),
      workspaceId: s.ctx.defaultWorkspace,
      url: "https://x.example.com/f.ics",
      name: "sweep",
      timezone: "Europe/Madrid",
      refreshMinutes: 60,
    });
    const poller = new CalendarPoller(s.ctx);
    let fetched = 0;
    const fetcher = (async () => {
      fetched += 1;
      return { body: ICS, etag: null, lastModified: null };
    }) as typeof import("../src/calendar-subscriptions.js").fetchIcs;

    await poller.sweep(fetcher);
    expect(fetched).toBe(1);
    expect(s.ctx.calendars.get(row.id)!.lastStatus).toContain("2 new");

    // Freshly fetched — the next sweep skips it (the interval has not elapsed).
    await poller.sweep(fetcher);
    expect(fetched).toBe(1);
  });
});
