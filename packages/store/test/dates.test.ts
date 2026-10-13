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

import { chainNodeIds, SYSTEM_CLASS_UUIDS } from "@notees/domain";
import { newEnvelope, type Envelope } from "@notees/protocol";

import { MoveGuardError, PropertyValueShapeError, Store, type StoreBackend } from "../src/index.js";
import { betterSqlite3Backend } from "../src/adapters/better-sqlite3.js";
import { sqljsBackend } from "../src/adapters/sqljs.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

const NODE_PAGE = "0192a000-0000-7000-8000-000000000010";
const PUBLISHED = "0192a000-0000-7000-8000-0000000000d1";
const SPAN = "0192a000-0000-7000-8000-0000000000d2";

/** Deterministic chain for the tests' fixed dates. */
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
      env("object.create", { objectId: NODE_PAGE }, 1727200000000),
      env("propertySchema.create", { propertySchemaId: PUBLISHED, name: "published", type: "datetime" }, 1727200000100),
      env("propertySchema.create", { propertySchemaId: SPAN, name: "span", type: "datetime" }, 1727200000200),
    ]);
    // PG6 target-existence: date refs must resolve — materialize the chains
    // the assertions link to (the ensureDateChain shape: year root, month
    // under it, day under that).
    for (const chain of [CHAIN_A, CHAIN_B]) {
      store.applyMany([
        env("object.create", { objectId: chain.year }, 1727200000300),
        env("object.create", { objectId: chain.month, parentId: chain.year }, 1727200000300),
        env("object.create", { objectId: chain.day, parentId: chain.month }, 1727200000300),
      ]);
    }
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
        { propertySchemaId: PRECISIONED, name: "founded", type: "datetime", datePrecision: "year" },
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
        { propertySchemaId: PRECISIONED, name: "founded", type: "datetime", datePrecision: "year" },
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
      // PG6: the linked node must exist.
      env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000e1" }, 1727200000900),
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
    // PC6: the legacy ISO-string qualifiers normalize ON WRITE to
    // deterministic day-node refs — the canonical date-node-backed shape.
    expect(JSON.parse(row.metadata)).toEqual({
      startDate: { nodeId: "00000000-0000-0000-00dd-202601010000" },
      endDate: { nodeId: "00000000-0000-0000-00dd-202612310000" },
    });
    // …and the effective read returns the refs (panel/export read both shapes).
    const effective = store.getEffectiveProperties(NODE_PAGE);
    expect(effective[0]?.metadata).toEqual({
      startDate: { nodeId: "00000000-0000-0000-00dd-202601010000" },
      endDate: { nodeId: "00000000-0000-0000-00dd-202612310000" },
    });
  });

  describe("datetime value union (SCHEMA.md Datetime)", () => {
    function valueRow(store: Store, schemaId: string): { value: string } | undefined {
      return store.database
        .prepare(
          "SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = 0",
        )
        .get(NODE_PAGE, schemaId) as { value: string } | undefined;
    }

    it("a timed point and a timed range end round-trip verbatim", () => {
      const store = makeStore();
      store.apply(
        env(
          "property.set",
          { objectId: NODE_PAGE, propertySchemaId: PUBLISHED, value: { nodeId: CHAIN_A.day, time: "14:30" } },
          1727200001000,
        ),
      );
      expect(valueRow(store, PUBLISHED)?.value).toBe(
        JSON.stringify({ nodeId: CHAIN_A.day, time: "14:30" }),
      );
      store.apply(
        env(
          "property.set",
          {
            objectId: NODE_PAGE,
            propertySchemaId: SPAN,
            value: { start: { nodeId: CHAIN_A.day }, end: { nodeId: CHAIN_B.day, time: "09:15" } },
          },
          1727200002000,
        ),
      );
      expect(valueRow(store, SPAN)?.value).toBe(
        JSON.stringify({
          start: { nodeId: CHAIN_A.day },
          end: { nodeId: CHAIN_B.day, time: "09:15" },
        }),
      );
      // The derived edges project from both slot refs (the timed end too).
      expect((store.backlinks(CHAIN_B.day) as unknown[]).length).toBe(1);
    });

    it("a both-open range is a legal value", () => {
      const store = makeStore();
      store.apply(
        env(
          "property.set",
          { objectId: NODE_PAGE, propertySchemaId: SPAN, value: { start: null, end: null } },
          1727200001000,
        ),
      );
      expect(valueRow(store, SPAN)?.value).toBe(JSON.stringify({ start: null, end: null }));
    });

    it("a value carrying BOTH nodeId and start/end keys is rejected outright", () => {
      const store = makeStore();
      for (const bad of [
        { nodeId: CHAIN_A.day, start: { nodeId: CHAIN_A.day }, end: null },
        { nodeId: CHAIN_A.day, end: null },
      ]) {
        expect(() =>
          store.apply(
            env("property.set", { objectId: NODE_PAGE, propertySchemaId: PUBLISHED, value: bad }, 1727200001000),
          ),
        ).toThrow(PropertyValueShapeError);
      }
    });

    it("a malformed time is rejected (points and range slots alike)", () => {
      const store = makeStore();
      for (const time of ["25:00", "9:30", "10:60", "14:30:00", 430, null]) {
        expect(() =>
          store.apply(
            env(
              "property.set",
              { objectId: NODE_PAGE, propertySchemaId: PUBLISHED, value: { nodeId: CHAIN_A.day, time } },
              1727200001000,
            ),
          ),
        ).toThrow(PropertyValueShapeError);
        expect(() =>
          store.apply(
            env(
              "property.set",
              {
                objectId: NODE_PAGE,
                propertySchemaId: SPAN,
                value: { start: null, end: { nodeId: CHAIN_B.day, time } },
              },
              1727200001000,
            ),
          ),
        ).toThrow(PropertyValueShapeError);
      }
    });

    it("time requires day precision on the slot's ref (a month/year anchor has no wall-clock time)", () => {
      const store = makeStore();
      expect(() =>
        store.apply(
          env(
            "property.set",
            { objectId: NODE_PAGE, propertySchemaId: PUBLISHED, value: { nodeId: CHAIN_A.month, time: "10:00" } },
            1727200001000,
          ),
        ),
      ).toThrow(PropertyValueShapeError);
      expect(() =>
        store.apply(
          env(
            "property.set",
            { objectId: NODE_PAGE, propertySchemaId: SPAN, value: { start: { nodeId: CHAIN_A.year, time: "10:00" }, end: null } },
            1727200001000,
          ),
        ),
      ).toThrow(PropertyValueShapeError);
    });

    it("time requires day precision on the schema ceiling too", () => {
      const store = makeStore();
      const YEARLY = "0192a000-0000-7000-8000-0000000000d5";
      store.apply(
        env(
          "propertySchema.create",
          { propertySchemaId: YEARLY, name: "yearly", type: "datetime", datePrecision: "year" },
          1727200000500,
        ),
      );
      // A full-day YEAR ref is fine at year precision…
      store.apply(
        env("property.set", { objectId: NODE_PAGE, propertySchemaId: YEARLY, value: { nodeId: CHAIN_A.year } }, 1727200001000),
      );
      expect(valueRow(store, YEARLY)?.value).toBe(JSON.stringify({ nodeId: CHAIN_A.year }));
      // …but a timed DAY ref claims finer granularity than the ceiling.
      expect(() =>
        store.apply(
          env(
            "property.set",
            { objectId: NODE_PAGE, propertySchemaId: YEARLY, value: { nodeId: CHAIN_A.day, time: "08:00" } },
            1727200002000,
          ),
        ),
      ).toThrow(/finer granularity/);
    });

    it("each non-null range slot ref gets the existence check (a ghost slot fails loud)", () => {
      const store = makeStore();
      // CHAIN_C (2028-01-15) is never materialized in makeStore — a valid
      // day-node id with no node row (the date_range parity: either end
      // missing fails, open sides skip).
      expect(() =>
        store.apply(
          env(
            "property.set",
            { objectId: NODE_PAGE, propertySchemaId: SPAN, value: { start: { nodeId: CHAIN_C.day }, end: null } },
            1727200001000,
          ),
        ),
      ).toThrow(/does not exist/);
      expect(() =>
        store.apply(
          env(
            "property.set",
            {
              objectId: NODE_PAGE,
              propertySchemaId: SPAN,
              value: { start: null, end: { nodeId: CHAIN_C.day, time: "12:00" } },
            },
            1727200001000,
          ),
        ),
      ).toThrow(/does not exist/);
      // Open sides store fine (no ref to check).
      store.apply(
        env("property.set", { objectId: NODE_PAGE, propertySchemaId: SPAN, value: { start: null, end: null } }, 1727200002000),
      );
      expect(valueRow(store, SPAN)?.value).toBe(JSON.stringify({ start: null, end: null }));
    });

    describe("date-chain parenting lock (SCHEMA.md 'Datetime', owner 2026-10-13)", () => {
      it("object.move rejects a date node anywhere but its deterministic chain parent", () => {
        const store = makeStore();
        // Under an arbitrary page.
        expect(() =>
          store.apply(env("object.move", { objectId: CHAIN_A.day, parentId: NODE_PAGE }, 1727200002000)),
        ).toThrow(MoveGuardError);
        // To the root.
        expect(() =>
          store.apply(env("object.move", { objectId: CHAIN_A.day, parentId: null }, 1727200002100)),
        ).toThrow(MoveGuardError);
        // A month under a DIFFERENT date's year node.
        expect(() =>
          store.apply(env("object.move", { objectId: CHAIN_A.month, parentId: CHAIN_B.year }, 1727200002200)),
        ).toThrow(MoveGuardError);
        // Non-date nodes stay movable (the guard keys on the date id).
        store.apply(env("object.move", { objectId: NODE_PAGE, parentId: null }, 1727200002300));
        // The rejected moves changed nothing.
        expect(store.getNode(CHAIN_A.day)?.parent_id).toBe(CHAIN_A.month);
        expect(store.getNode(CHAIN_A.month)?.parent_id).toBe(CHAIN_A.year);
      });

      it("object.move allows the chain-correct parent (the client self-heal rides it)", () => {
        const store = makeStore();
        store.apply(env("object.move", { objectId: CHAIN_A.day, parentId: CHAIN_A.month }, 1727200003000));
        store.apply(env("object.move", { objectId: CHAIN_A.month, parentId: CHAIN_A.year }, 1727200003100));
        store.apply(env("object.move", { objectId: CHAIN_A.year, parentId: null }, 1727200003200));
        expect(store.getNode(CHAIN_A.day)?.parent_id).toBe(CHAIN_A.month);
        expect(store.getNode(CHAIN_A.month)?.parent_id).toBe(CHAIN_A.year);
        expect(store.getNode(CHAIN_A.year)?.parent_id).toBeNull();
      });

      it("object.create rejects a date id claiming a non-chain parent; parentless and chain shapes stay legal", () => {
        const store = makeStore();
        const stray = chainNodeIds("2029-03-04");
        expect(() =>
          store.apply(env("object.create", { objectId: stray.day, parentId: NODE_PAGE }, 1727200004000)),
        ).toThrow(MoveGuardError);
        expect(() =>
          store.apply(env("object.create", { objectId: stray.year, parentId: NODE_PAGE }, 1727200004100)),
        ).toThrow(MoveGuardError);
        // The standalone shape (parentless) is legal — the client chain
        // self-heal adopts it onto the chain.
        store.apply(env("object.create", { objectId: stray.day }, 1727200004150));
        expect(store.getNode(stray.day)?.parent_id).toBeNull();
        // The chain-correct shape (a fresh chain): year at root, month under
        // year, day under month.
        const fresh = chainNodeIds("2029-04-07");
        store.applyMany([
          env("object.create", { objectId: fresh.year, classIds: [SYSTEM_CLASS_UUIDS.year] }, 1727200004200),
          env("object.create", { objectId: fresh.month, parentId: fresh.year, classIds: [SYSTEM_CLASS_UUIDS.month] }, 1727200004300),
          env("object.create", { objectId: fresh.day, parentId: fresh.month, classIds: [SYSTEM_CLASS_UUIDS.day] }, 1727200004400),
        ]);
        expect(store.getNode(fresh.day)?.parent_id).toBe(fresh.month);
      });

      it("object.create rejects a date id carrying a FOREIGN class — fresh and re-issued (the OR-Set add carrier)", () => {
        const store = makeStore();
        const stray = chainNodeIds("2029-05-06");
        // Fresh create with a foreign class.
        expect(() =>
          store.apply(env("object.create", { objectId: stray.day, classIds: [SYSTEM_CLASS_UUIDS.task] }, 1727200005000)),
        ).toThrow(MoveGuardError);
        // The re-issued create (class.assign's add carrier) on an EXISTING
        // date node — the guard runs before the re-create early return.
        expect(() =>
          store.apply(env("object.create", { objectId: CHAIN_A.day, classIds: [SYSTEM_CLASS_UUIDS.task] }, 1727200005100)),
        ).toThrow(MoveGuardError);
        // Its own system class re-add stays legal (the ensureDateChain carrier).
        store.apply(env("object.create", { objectId: CHAIN_A.day, classIds: [SYSTEM_CLASS_UUIDS.day] }, 1727200005200));
      });

      it("class.unassign refuses the precision's system class; a foreign cleanup stays legal", () => {
        const store = makeStore();
        expect(() =>
          store.apply(env("class.unassign", { objectId: CHAIN_A.day, classId: SYSTEM_CLASS_UUIDS.day }, 1727200006000)),
        ).toThrow(MoveGuardError);
        // A foreign class was never assignable; removing one is legal
        // cleanup of a legacy violation, not a lock breach.
        store.apply(
          env("class.unassign", { objectId: CHAIN_A.day, classId: "0192a000-0000-7000-8000-0000000000f1" }, 1727200006100),
        );
      });

      it("class.create never declares a date node a class", () => {
        const store = makeStore();
        expect(() =>
          store.apply(env("class.create", { classId: CHAIN_A.year }, 1727200007000)),
        ).toThrow(MoveGuardError);
      });
    });
  });
});
