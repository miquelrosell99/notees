/**
 * Dates (SCHEMA.md "Dates") — store level:
 *
 *  - date property values are `{ "nodeId": <deterministic date-node id> }`
 *    refs; the edge projection is VALUE-SHAPE keyed, so they project like
 *    any node-typed value — a year node's backlinks list everything dated
 *    that year (the store-check outcome: no type-keyed change needed).
 *  - date_range values ({ start, end } of refs, either side open) project
 *    each present end.
 *  - propertySchema.create/update round-trip datePrecision/dateQualified
 *    onto the schema row, and the effective read model exposes them.
 *
 * Runs against BOTH shipped adapters, like the main store suite.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import initSqlJs, { type SqlJsStatic } from "sql.js";

import { chainNodeIds } from "@notees/domain";
import { newEnvelope, type Envelope } from "@notees/protocol";

import { Store, type StoreBackend } from "../src/index.js";
import { betterSqlite3Backend } from "../src/adapters/better-sqlite3.js";
import { sqljsBackend } from "../src/adapters/sqljs.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

const NODE_PAGE = "0192a000-0000-7000-8000-000000000010";
const PUBLISHED = "0192a000-0000-7000-8000-0000000000d1";
const SPAN = "0192a000-0000-7000-8000-0000000000d2";

/** Deterministic chain for the tests' fixed dates (v1 scheme). */
const CHAIN_A = chainNodeIds("2026-09-27");
const CHAIN_B = chainNodeIds("2027-10-05");
const CHAIN_C = chainNodeIds("2028-01-15");

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const adapters: { name: string; makeBackend: () => StoreBackend }[] = [
  { name: "sqljs", makeBackend: () => sqljsBackend(sqlModule) },
  {
    name: "better-sqlite3",
    makeBackend: () => {
      const dir = mkdtempSync(join(tmpdir(), "notees-store-dates-test-"));
      tmpDirs.push(dir);
      return betterSqlite3Backend(join(dir, "store.db"));
    },
  },
];

describe.each(adapters)("$name: dates (SCHEMA.md)", ({ makeBackend }) => {
  function env(opType: string, payload: Record<string, unknown>, physical: number): Envelope {
    return newEnvelope({
      workspaceId: WS,
      actorId: ACTOR,
      deviceId: "test-device-store-dates",
      hlc: { physical, logical: 0 },
      opType,
      payload,
      timestamp: new Date(physical).toISOString(),
    });
  }

  function makeStore(): Store {
    const store = Store.open(makeBackend());
    store.applyMany([
      env("object.create", { objectId: NODE_PAGE, nodeType: "page" }, 1727200000000),
      env("propertySchema.create", { propertySchemaId: PUBLISHED, name: "published", type: "date" }, 1727200000100),
      env("propertySchema.create", { propertySchemaId: SPAN, name: "span", type: "date_range" }, 1727200000200),
    ]);
    return store;
  }

  it("a date ref projects an edge: the year node's backlinks list the dated node", () => {
    const store = makeStore();
    store.apply(
      env("property.set", { objectId: NODE_PAGE, propertySchemaId: PUBLISHED, value: { nodeId: CHAIN_A.day }, idx: 0 }, 1727200001000),
    );

    const yearBacklinks = store.backlinks(CHAIN_A.year) as Array<{ source_id: string; type: string; verb: string }>;
    expect(yearBacklinks).toEqual([
      expect.objectContaining({ source_id: NODE_PAGE, type: "property", verb: PUBLISHED }),
    ]);
    // The month and day chains are linked too (value shape keys on {nodeId}).
    expect((store.backlinks(CHAIN_A.month) as unknown[]).length).toBe(1);
    expect((store.backlinks(CHAIN_A.day) as unknown[]).length).toBe(1);
    // An unrelated year is untouched.
    expect(store.backlinks(CHAIN_C.year)).toEqual([]);
  });

  it("a date_range projects each present end; an open end projects nothing on that side", () => {
    const store = makeStore();
    // Open start, set end.
    store.apply(
      env(
        "property.set",
        {
          objectId: NODE_PAGE,
          propertySchemaId: SPAN,
          value: { start: null, end: { nodeId: CHAIN_B.day } },
          idx: 0,
        },
        1727200001000,
      ),
    );
    expect(store.backlinks(CHAIN_A.year)).toEqual([]); // start is open: nothing dated at A
    expect((store.backlinks(CHAIN_B.year) as unknown[]).length).toBe(1);
    expect((store.backlinks(CHAIN_B.day) as unknown[]).length).toBe(1);

    // Widen: set the start too; both ends now project.
    store.apply(
      env(
        "property.set",
        {
          objectId: NODE_PAGE,
          propertySchemaId: SPAN,
          value: { start: { nodeId: CHAIN_A.day }, end: { nodeId: CHAIN_B.day } },
          idx: 0,
        },
        1727200002000,
      ),
    );
    expect((store.backlinks(CHAIN_A.day) as unknown[]).length).toBe(1);
    expect((store.backlinks(CHAIN_B.day) as unknown[]).length).toBe(1);
  });

  it("unsetting the value removes the derived edges (rebuild on property.unset)", () => {
    const store = makeStore();
    store.apply(
      env("property.set", { objectId: NODE_PAGE, propertySchemaId: PUBLISHED, value: { nodeId: CHAIN_A.day }, idx: 0 }, 1727200001000),
    );
    expect((store.backlinks(CHAIN_A.year) as unknown[]).length).toBe(1);
    store.apply(
      env("property.unset", { objectId: NODE_PAGE, propertySchemaId: PUBLISHED, idx: 0 }, 1727200002000),
    );
    expect(store.backlinks(CHAIN_A.year)).toEqual([]);
  });

  it("propertySchema.create stores datePrecision/dateQualified; update patches them", () => {
    const store = makeStore();
    const PRECISIONED = "0192a000-0000-7000-8000-0000000000d3";
    store.apply(
      env(
        "propertySchema.create",
        { propertySchemaId: PRECISIONED, name: "founded", type: "date", datePrecision: "year" },
        1727200000500,
      ),
    );
    let row = store.database
      .prepare("SELECT date_precision, date_qualified FROM property_schema WHERE id = ?")
      .get(PRECISIONED) as { date_precision: string | null; date_qualified: number | null };
    expect(row).toEqual({ date_precision: "year", date_qualified: null });

    // Qualified node-typed schema + a precision downgrade via update.
    const LINKED = "0192a000-0000-7000-8000-0000000000d4";
    store.applyMany([
      env(
        "propertySchema.create",
        { propertySchemaId: LINKED, name: "member", type: "object", dateQualified: true },
        1727200000600,
      ),
      env("propertySchema.update", { propertySchemaId: PRECISIONED, datePrecision: "month" }, 1727200000700),
    ]);
    row = store.database
      .prepare("SELECT date_precision, date_qualified FROM property_schema WHERE id = ?")
      .get(PRECISIONED) as { date_precision: string | null; date_qualified: number | null };
    expect(row.date_precision).toBe("month");
    const linkRow = store.database
      .prepare("SELECT date_qualified FROM property_schema WHERE id = ?")
      .get(LINKED) as { date_qualified: number | null };
    expect(linkRow.date_qualified).toBe(1);
  });

  it("the effective read model exposes the schema's date behavior", () => {
    const store = makeStore();
    const PRECISIONED = "0192a000-0000-7000-8000-0000000000d3";
    store.applyMany([
      env(
        "propertySchema.create",
        { propertySchemaId: PRECISIONED, name: "founded", type: "date", datePrecision: "year" },
        1727200000500,
      ),
      env("property.set", { objectId: NODE_PAGE, propertySchemaId: PRECISIONED, value: { nodeId: CHAIN_A.year }, idx: 0 }, 1727200001000),
      env("property.set", { objectId: NODE_PAGE, propertySchemaId: PUBLISHED, value: { nodeId: CHAIN_A.day }, idx: 0 }, 1727200001000),
    ]);
    const effective = store.getEffectiveProperties(NODE_PAGE);
    const founded = effective.find((row) => row.propertySchemaId === PRECISIONED);
    expect(founded?.schema).toMatchObject({ datePrecision: "year", dateQualified: null });
    const published = effective.find((row) => row.propertySchemaId === PUBLISHED);
    expect(published?.schema).toMatchObject({ datePrecision: null, dateQualified: null });
  });

  it("per-value metadata (link qualifiers) round-trips through the value row", () => {
    const store = makeStore();
    const LINKED = "0192a000-0000-7000-8000-0000000000d4";
    store.applyMany([
      env(
        "propertySchema.create",
        { propertySchemaId: LINKED, name: "member", type: "object", dateQualified: true },
        1727200000600,
      ),
      env(
        "property.set",
        {
          objectId: NODE_PAGE,
          propertySchemaId: LINKED,
          value: { nodeId: "0192a000-0000-7000-8000-0000000000e1" },
          idx: 0,
          metadata: { startDate: "2026-01-01", endDate: "2026-12-31" },
        },
        1727200001000,
      ),
    ]);
    const row = store.database
      .prepare("SELECT metadata FROM property_value WHERE node_id = ? AND property_schema_id = ?")
      .get(NODE_PAGE, LINKED) as { metadata: string };
    expect(JSON.parse(row.metadata)).toEqual({ startDate: "2026-01-01", endDate: "2026-12-31" });
  });
});
