/**
 * Compile-time placeholder tests: the `{today}`-style
 * editor-relative date tokens resolve at COMPILE time against the
 * `CompileOptions.now` clock (runtime default: the current instant), in
 * createdAfter/createdBefore timestamps and comparison-bound property values.
 * Covers the resolution unit semantics (week/month/year boundaries), the
 * compiled SQL params, and end-to-end execution against a real store —
 * including the date-node-ref containment arm for `{"nodeId": …}` date values.
 */

import { beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { chainNodeIds } from "@notees/domain";
import { newEnvelope, type Envelope } from "@notees/protocol";
import { Store } from "@notees/store";
import { sqljsBackend } from "@notees/store/sqljs";

import {
  compile,
  placeholderEndDate,
  placeholderStartDate,
  resolveTimestampPlaceholder,
  resolveValuePlaceholder,
  runQuery,
  type Child,
  type QueryAst,
  type Scope,
} from "../src/index.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

const NODE_A = "0192a000-0000-7000-8000-000000000101";
const NODE_B = "0192a000-0000-7000-8000-000000000102";
const OPENED = "0192a000-0000-7000-8000-000000000301";

// Local noon: the UTC calendar day equals the local one for every real-world
// offset, so the tests are timezone-independent.
const NOW = new Date(2026, 9, 4, 12, 0, 0, 0); // Sunday 2026-10-04, 12:00 local
const NOW_MS = NOW.getTime();

function ast(children: Child[]): QueryAst {
  return {
    version: 1,
    scope: { type: "entire_workspace" },
    root: { type: "group", logic: "and", children },
  };
}

const entire: Scope = { type: "entire_workspace" };

// --- resolution units ---------------------------------------------------------

describe("placeholder date resolution", () => {
  it("{today} is the local calendar day", () => {
    expect(placeholderStartDate("{today}", { now: NOW })).toBe("2026-10-04");
    expect(placeholderEndDate("{today}", { now: NOW })).toBe("2026-10-04");
  });

  it("{this_week} spans the ISO week (Monday start; the pinned day is a Sunday)", () => {
    expect(placeholderStartDate("{this_week}", { now: NOW })).toBe("2026-09-28");
    expect(placeholderEndDate("{this_week}", { now: NOW })).toBe("2026-10-04");
    // A Wednesday belongs to the same week.
    const wednesday = new Date(2026, 9, 1, 12, 0, 0, 0);
    expect(placeholderStartDate("{this_week}", { now: wednesday })).toBe("2026-09-28");
    // A Monday starts a fresh week.
    const monday = new Date(2026, 9, 5, 12, 0, 0, 0);
    expect(placeholderStartDate("{this_week}", { now: monday })).toBe("2026-10-05");
  });

  it("{this_month} and {this_year} resolve to period edges", () => {
    expect(placeholderStartDate("{this_month}", { now: NOW })).toBe("2026-10-01");
    expect(placeholderEndDate("{this_month}", { now: NOW })).toBe("2026-10-31");
    expect(placeholderStartDate("{this_year}", { now: NOW })).toBe("2026-01-01");
    expect(placeholderEndDate("{this_year}", { now: NOW })).toBe("2026-12-31");
    // Leap-year February edge.
    const leap = new Date(2024, 1, 10, 12, 0, 0, 0);
    expect(placeholderEndDate("{this_month}", { now: leap })).toBe("2024-02-29");
  });

  it("unknown tokens resolve to null (not a placeholder) and pass through verbatim", () => {
    expect(placeholderStartDate("{banana}", { now: NOW })).toBeNull();
    expect(resolveTimestampPlaceholder("{banana}", "after", { now: NOW })).toBe("{banana}");
    expect(resolveValuePlaceholder("2026-10-04", { now: NOW })).toBe("2026-10-04");
  });

  it("timestamps resolve to the local day's UTC boundaries (created_at is UTC on the wire)", () => {
    // The bound is the LOCAL calendar day's boundary expressed in UTC, so it
    // compares correctly with UTC created_at strings on any machine offset.
    const dayStart = new Date(2026, 9, 4, 0, 0, 0, 0).toISOString();
    const dayEnd = new Date(2026, 9, 4, 23, 59, 59, 999).toISOString();
    expect(resolveTimestampPlaceholder("{today}", "after", { now: NOW })).toBe(dayStart);
    expect(resolveTimestampPlaceholder("{today}", "before", { now: NOW })).toBe(dayEnd);
    expect(resolveTimestampPlaceholder("{this_year}", "after", { now: NOW })).toBe(
      new Date(2026, 0, 1, 0, 0, 0, 0).toISOString(),
    );
    // The bound IS a valid UTC instant: everything created inside the local
    // day (now included) falls between the two boundaries.
    expect(new Date(NOW_MS).toISOString() >= dayStart).toBe(true);
    expect(new Date(NOW_MS).toISOString() <= dayEnd).toBe(true);
  });
});

// --- compiled params ------------------------------------------------------------

describe("placeholder compilation", () => {
  it("createdAfter/createdBefore resolve against the pinned clock", () => {
    const { params } = compile(
      ast([
        { type: "createdAfter", timestamp: "{today}" },
        { type: "createdBefore", timestamp: "{this_week}" },
      ]),
      { now: NOW },
    );
    // After = start of the local day; Before = end of the local day (a
    // Sunday — the ISO week's last day).
    expect(params).toEqual([
      new Date(2026, 9, 4, 0, 0, 0, 0).toISOString(),
      new Date(2026, 9, 4, 23, 59, 59, 999).toISOString(),
    ]);
  });

  it("a comparison-bound property value resolves to the period start date (date-ref arms apply)", () => {
    const eq = compile(ast([{ type: "property", schemaId: OPENED, op: "eq", value: "{today}" }]), {
      now: NOW,
    });
    // Same param shape as typing the date by hand: scalar + day/month/year
    // point arms + the range arm (start payload bound, then the end-side
    // day/month/year bounds).
    expect(eq.params).toEqual([
      OPENED, OPENED, OPENED, "2026-10-04",
      "20261004", "202610", "2026",
      "202610040000", "20261004", "202610", "2026",
    ]);
    expect(eq.sql).toContain("substr(json_extract(value, '$.nodeId'), 25, 8)");
    expect(eq.sql).toContain("json_extract(value, '$.start.nodeId')");
  });

  it("range ops resolve the bound the same way", () => {
    const gte = compile(ast([{ type: "property", schemaId: OPENED, op: "gte", value: "{this_month}" }]), {
      now: NOW,
    });
    expect(gte.params).toEqual([OPENED, OPENED, OPENED, "2026-10-01", "202610010000", "202610010000"]);
  });

  it("contains keeps the token literal; unknown tokens pass through in every position", () => {
    const contains = compile(ast([{ type: "property", schemaId: OPENED, op: "contains", value: "{today}" }]), {
      now: NOW,
    });
    expect(contains.params).toEqual([OPENED, OPENED, OPENED, "{today}"]);
    const unknown = compile(
      ast([
        { type: "createdAfter", timestamp: "{someday}" },
        { type: "property", schemaId: OPENED, op: "eq", value: "{foo}" },
      ]),
      { now: NOW },
    );
    expect(unknown.params).toEqual(["{someday}", OPENED, OPENED, OPENED, "{foo}"]);
  });
});

// --- execution against a real store ----------------------------------------------

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

function env(opType: string, payload: Record<string, unknown>, offsetMs: number): Envelope {
  const physical = NOW_MS + offsetMs;
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: "test-device-placeholders",
    hlc: { physical, logical: 0 },
    opType,
    payload,
    timestamp: new Date(physical).toISOString(),
  });
}

const text = (s: string) => [{ type: "text", text: s }];

/** Two plain nodes created yesterday/today + an "opened" date property (today + last month). */
function worldStore(): Store {
  const store = Store.open(sqljsBackend(sqlModule));
  const day = (offset: number) => {
    const d = new Date(NOW_MS);
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const todayId = chainNodeIds(day(0)).day;
  const lastMonthId = chainNodeIds(day(-35)).day;
  store.applyMany([
    env("object.create", { objectId: NODE_A, contentAst: text("Alpha") }, -24 * 3600 * 1000),
    env("object.create", { objectId: NODE_B, contentAst: text("Beta") }, -3600 * 1000),
    // PG6 target-existence: the date chains the values link must exist.
    env("object.create", { objectId: chainNodeIds(day(0)).year, contentAst: text("y0") }, -3200),
    env("object.create", { objectId: chainNodeIds(day(0)).month, parentId: chainNodeIds(day(0)).year, contentAst: text("m0") }, -3100),
    env("object.create", { objectId: todayId, parentId: chainNodeIds(day(0)).month, contentAst: text("d0") }, -3000),
    env("object.create", { objectId: chainNodeIds(day(-35)).year, contentAst: text("y1") }, -3200),
    env("object.create", { objectId: chainNodeIds(day(-35)).month, parentId: chainNodeIds(day(-35)).year, contentAst: text("m1") }, -3100),
    env("object.create", { objectId: lastMonthId, parentId: chainNodeIds(day(-35)).month, contentAst: text("d1") }, -3000),
    env("propertySchema.create", { propertySchemaId: OPENED, name: "opened", type: "datetime" }, -3000),
    env("property.set", { objectId: NODE_A, propertySchemaId: OPENED, value: { nodeId: todayId } }, -2000),
    env("property.set", { objectId: NODE_B, propertySchemaId: OPENED, value: { nodeId: lastMonthId } }, -1000),
  ]);
  return store;
}

describe("placeholder execution", () => {
  it("createdAfter {today} floors at today midnight; createdBefore {today} ceilings at end of day", () => {
    const store = worldStore();
    // Both bounds are inclusive: a node created today matches each side;
    // yesterday's node only matches the Before side.
    const after = runQuery(store, ast([{ type: "createdAfter", timestamp: "{today}" }]), { now: NOW });
    expect(after.ids).toContain(NODE_B);
    expect(after.ids).not.toContain(NODE_A);
    const before = runQuery(store, ast([{ type: "createdBefore", timestamp: "{today}" }]), { now: NOW });
    expect(before.ids).toContain(NODE_A);
    expect(before.ids).toContain(NODE_B);
  });

  it("a date property eq {today} matches the node dated today (date-node containment), not last month's", () => {
    const store = worldStore();
    const result = runQuery(
      store,
      ast([{ type: "property", schemaId: OPENED, op: "eq", value: "{today}" }]),
      { now: NOW },
    );
    expect(result.ids).toEqual([NODE_A]);
  });

  it("gte {this_month} keeps today's date and drops last month's", () => {
    const store = worldStore();
    const result = runQuery(
      store,
      ast([{ type: "property", schemaId: OPENED, op: "gte", value: "{this_month}" }]),
      { now: NOW },
    );
    expect(result.ids).toEqual([NODE_A]);
  });
});
