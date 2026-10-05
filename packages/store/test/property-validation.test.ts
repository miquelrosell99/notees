/**
 * PG6 + PB1 validation batch (§34.32 register, owner-ruling pass 2026-10-04):
 *
 *  - PG6 apply-time fail-loud validation, extending §34.45's one-shape
 *    validator with the register's remaining gaps: scalar typing
 *    (number/boolean/url/email/select/multi_select), the multi cardinality
 *    ceiling, datePrecision ceilings, targetClassFilter membership, and
 *    node-typed target existence — asserted on BOTH store adapters.
 *    Evidence-scoped deviations (live-owner-data verified 2026-10-04):
 *    numeric strings normalize for number (v1 epoch-millis), image stays
 *    unchecked (PG14 zombie — v1 asset payloads ride the log), text
 *    carriers skip existence checks (PB2 legacy leniency).
 *  - PB1 broken-target rule: a node-typed value pointing at a
 *    deleted/trashed node KEEPS the value (no cascade) and the edge index
 *    keeps the derived edge — the permanent-delete applier no longer drops
 *    incoming rows (rebuild would re-derive them identically: the
 *    register's transient resurrection), and rebuildEdges itself never
 *    drops a broken ref silently.
 *
 * Runs against BOTH shipped adapters, like the main store suite.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import initSqlJs, { type SqlJsStatic } from "sql.js";

import { newEnvelope, type ContentAst, type Envelope } from "@notees/protocol";
import { dayNodeId, monthNodeId, yearNodeId } from "@notees/domain";

import {
  PropertyValueShapeError,
  Store,
  rebuildEdges,
  type StoreBackend,
} from "../src/index.js";
import { betterSqlite3Backend } from "../src/adapters/better-sqlite3.js";
import { sqljsBackend } from "../src/adapters/sqljs.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

const OWNER = "0192a000-0000-7000-8000-000000000010";
const OWNER2 = "0192a000-0000-7000-8000-000000000011";
const TARGET = "0192a000-0000-7000-8000-000000000020";
const TARGET2 = "0192a000-0000-7000-8000-000000000021";
const GHOST = "0192a000-0000-7000-8000-000000000099";
const CLASS_A = "0192a000-0000-7000-8000-0000000000c1";
const CLASS_B = "0192a000-0000-7000-8000-0000000000c2";

const SCHEMA_TEXT = "0192a000-0000-7000-8000-0000000000a1";
const SCHEMA_TEXT_MULTI = "0192a000-0000-7000-8000-0000000000a2";
const SCHEMA_NUMBER = "0192a000-0000-7000-8000-0000000000a3";
const SCHEMA_BOOLEAN = "0192a000-0000-7000-8000-0000000000a4";
const SCHEMA_URL = "0192a000-0000-7000-8000-0000000000a5";
const SCHEMA_SELECT = "0192a000-0000-7000-8000-0000000000a6";
const SCHEMA_MULTI_SELECT = "0192a000-0000-7000-8000-0000000000a7";
const SCHEMA_IMAGE = "0192a000-0000-7000-8000-0000000000a8";
const SCHEMA_DATE = "0192a000-0000-7000-8000-0000000000a9";
const SCHEMA_DATE_YEAR = "0192a000-0000-7000-8000-0000000000aa";
const SCHEMA_OBJECT_FILTERED = "0192a000-0000-7000-8000-0000000000ab";
const SCHEMA_RANGE = "0192a000-0000-7000-8000-0000000000ac";
const SCHEMA_UNKNOWN = "0192a000-0000-7000-8000-0000000000af";

const YEAR_NODE = yearNodeId("2026-01-01");
const MONTH_NODE = monthNodeId("2026-09-01");
const DAY_NODE = dayNodeId("2026-09-27");
const DAY2_NODE = dayNodeId("2026-09-28");

function env(
  opType: string,
  payload: Record<string, unknown>,
  physical: number,
  logical = 0,
  actor = ACTOR,
): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: actor,
    deviceId: "test-device-valid",
    hlc: { physical, logical },
    opType,
    payload,
    timestamp: new Date(physical).toISOString(),
  });
}

function text(textValue: string): ContentAst {
  return [{ type: "text", text: textValue }];
}

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
      const dir = mkdtempSync(join(tmpdir(), "notees-valid-test-"));
      tmpDirs.push(dir);
      return betterSqlite3Backend(join(dir, "store.db"));
    },
  },
];

describe.each(adapters)("$name", ({ makeBackend }) => {
  function makeStore(): Store {
    return Store.open(makeBackend());
  }

  /** Owner + targets/classes + the full schema menu the suite writes through. */
  function seededStore(): Store {
    const store = makeStore();
    let ts = 1727200000000;
    const step = (): number => (ts += 100);
    store.apply(env("object.create", { objectId: OWNER, contentAst: text("Owner") }, step()));
    store.apply(env("object.create", { objectId: OWNER2, contentAst: text("Owner 2") }, step()));
    store.apply(env("object.create", { objectId: TARGET, contentAst: text("Target A") }, step()));
    store.apply(env("object.create", { objectId: TARGET2, contentAst: text("Target B") }, step()));
    store.apply(env("class.create", { classId: CLASS_A, contentAst: text("ClassA") }, step()));
    store.apply(env("class.create", { classId: CLASS_B, contentAst: text("ClassB") }, step()));
    // TARGET carries ClassA; TARGET2 carries ClassB.
    store.apply(
      env("object.create", { objectId: TARGET, classIds: [CLASS_A], contentAst: text("Target A") }, step()),
    );
    store.apply(
      env("object.create", { objectId: TARGET2, classIds: [CLASS_B], contentAst: text("Target B") }, step()),
    );
    for (const [id, body] of [
      [SCHEMA_TEXT, { name: "notes", type: "text" }],
      [SCHEMA_TEXT_MULTI, { name: "aliases", type: "text", multi: true }],
      [SCHEMA_NUMBER, { name: "count", type: "number" }],
      [SCHEMA_BOOLEAN, { name: "done", type: "boolean" }],
      [SCHEMA_URL, { name: "link", type: "url" }],
      [SCHEMA_SELECT, { name: "state", type: "select", options: [{ id: "opt-1", label: "One" }] }],
      [SCHEMA_MULTI_SELECT, { name: "tags", type: "multi_select" }],
      [SCHEMA_IMAGE, { name: "cover", type: "image" }],
      [SCHEMA_DATE, { name: "when", type: "date" }],
      [SCHEMA_DATE_YEAR, { name: "yearOf", type: "date", datePrecision: "year" }],
      [SCHEMA_OBJECT_FILTERED, { name: "ref", type: "object", targetClassFilter: [CLASS_A] }],
      [SCHEMA_RANGE, { name: "span", type: "date_range" }],
    ] as const) {
      store.apply(env("propertySchema.create", { propertySchemaId: id, ...body }, step()));
    }
    // The date chain the date tests link to (ensureDateChain shape: year
    // root, month under it, day under that).
    store.applyMany([
      env("object.create", { objectId: YEAR_NODE }, step()),
      env("object.create", { objectId: MONTH_NODE, parentId: YEAR_NODE }, step()),
      env("object.create", { objectId: DAY_NODE, parentId: MONTH_NODE }, step()),
      env("object.create", { objectId: DAY2_NODE, parentId: MONTH_NODE }, step()),
    ]);
    return store;
  }

  function valueRow(store: Store, schemaId: string, idx = 0): { value: string } | undefined {
    return store.database
      .prepare("SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = ?")
      .get(OWNER, schemaId, idx) as { value: string } | undefined;
  }

  function edgeRows(store: Store, sourceId: string): Array<{ target_id: string | null; type: string }> {
    return store.database
      .prepare("SELECT target_id, type FROM edge WHERE source_id = ? ORDER BY id")
      .all(sourceId) as Array<{ target_id: string | null; type: string }>;
  }

  describe("PG6: scalar typing", () => {
    it("number accepts finite numbers and normalizes legacy numeric strings; other strings fail loud", () => {
      const store = seededStore();
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_NUMBER, value: 42 }, 1727200005000));
      expect(valueRow(store, SCHEMA_NUMBER)?.value).toBe("42");
      // v1-migrated epoch-millis encoding (live-data evidence).
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_NUMBER, value: "1757427533728" }, 1727200005100));
      expect(valueRow(store, SCHEMA_NUMBER)?.value).toBe("1757427533728");
      for (const bad of ["abc", "", [1], {}, true, NaN]) {
        expect(() =>
          store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_NUMBER, value: bad }, 1727200005200)),
        ).toThrow(PropertyValueShapeError);
      }
    });

    it("boolean/url/email/select accept their scalar and reject other shapes", () => {
      const store = seededStore();
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_BOOLEAN, value: true }, 1727200005000));
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_URL, value: "https://x.test" }, 1727200005100));
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_SELECT, value: "opt-1" }, 1727200005200));
      expect(() =>
        store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_BOOLEAN, value: "true" }, 1727200005300)),
      ).toThrow(PropertyValueShapeError);
      expect(() =>
        store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_URL, value: 42 }, 1727200005300)),
      ).toThrow(PropertyValueShapeError);
      expect(() =>
        store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_SELECT, value: ["opt-1"] }, 1727200005300)),
      ).toThrow(PropertyValueShapeError);
    });

    it("multi_select takes an array of strings only", () => {
      const store = seededStore();
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_MULTI_SELECT, value: ["a", "b"] }, 1727200005000));
      expect(valueRow(store, SCHEMA_MULTI_SELECT)?.value).toBe(JSON.stringify(["a", "b"]));
      for (const bad of ["a", [1], [null], {}]) {
        expect(() =>
          store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_MULTI_SELECT, value: bad }, 1727200005100)),
        ).toThrow(PropertyValueShapeError);
      }
    });

    it("image passes through unchecked (PG14 zombie — no defined value shape yet)", () => {
      const store = seededStore();
      // A v1-migrated asset payload rides the live log — it must not fail.
      const v1Payload = { hash: "abc", size: 12, filename: "", mime_type: "image/png" };
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_IMAGE, value: v1Payload }, 1727200005000));
      expect(valueRow(store, SCHEMA_IMAGE)?.value).toBe(JSON.stringify(v1Payload));
    });
  });

  describe("PG6: cardinality, precision, filter, existence", () => {
    it("single-value schemas reject idx > 0; multi schemas accept higher slots", () => {
      const store = seededStore();
      expect(() =>
        store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_TEXT, value: "x", idx: 1 }, 1727200005000)),
      ).toThrow(PropertyValueShapeError);
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_TEXT_MULTI, value: "one", idx: 1 }, 1727200005100));
      expect(valueRow(store, SCHEMA_TEXT_MULTI, 1)?.value).toBe(JSON.stringify("one"));
    });

    it("date refs may not claim finer granularity than the schema's precision", () => {
      const store = seededStore();
      // day-precision schema: day/month/year refs all fine.
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_DATE, value: { nodeId: DAY_NODE } }, 1727200005000));
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_DATE, value: { nodeId: YEAR_NODE } }, 1727200005100));
      // year-precision schema: a year ref is fine, a day ref fails loud.
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_DATE_YEAR, value: { nodeId: YEAR_NODE } }, 1727200005200));
      expect(() =>
        store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_DATE_YEAR, value: { nodeId: DAY_NODE } }, 1727200005300)),
      ).toThrow(PropertyValueShapeError);
      expect(() =>
        store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_DATE_YEAR, value: { nodeId: MONTH_NODE } }, 1727200005400)),
      ).toThrow(PropertyValueShapeError);
    });

    it("targetClassFilter: filtered object schemas reject out-of-filter targets", () => {
      const store = seededStore();
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_OBJECT_FILTERED, value: { nodeId: TARGET } }, 1727200005000));
      expect(valueRow(store, SCHEMA_OBJECT_FILTERED)?.value).toBe(JSON.stringify({ nodeId: TARGET }));
      // TARGET2 carries ClassB, the schema allows ClassA only.
      expect(() =>
        store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_OBJECT_FILTERED, value: { nodeId: TARGET2 } }, 1727200005100)),
      ).toThrow(PropertyValueShapeError);
    });

    it("node-typed refs must exist: date/object refs and date_range ends fail loud on ghosts", () => {
      const store = seededStore();
      expect(() =>
        store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_DATE, value: { nodeId: GHOST } }, 1727200005000)),
      ).toThrow(PropertyValueShapeError);
      expect(() =>
        store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_OBJECT_FILTERED, value: { nodeId: GHOST } }, 1727200005100)),
      ).toThrow(/does not exist/);
      // date_range: either end missing fails (other end open is fine).
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_RANGE, value: { start: { nodeId: DAY_NODE }, end: null } }, 1727200005200));
      expect(() =>
        store.apply(
          env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_RANGE, value: { start: { nodeId: DAY_NODE }, end: { nodeId: GHOST } } }, 1727200005300),
        ),
      ).toThrow(/does not exist/);
      // A TRASHED target still exists (trash is a state, not an absence) —
      // TARGET carries ClassA, so the filtered schema accepts it even while
      // trashed.
      store.apply(env("object.delete", { objectId: TARGET }, 1727200005400));
      store.apply(
        env("property.set", { objectId: OWNER2, propertySchemaId: SCHEMA_OBJECT_FILTERED, value: { nodeId: TARGET } }, 1727200005500),
      );
      const filteredRow = store.database
        .prepare("SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = ?")
        .get(OWNER2, SCHEMA_OBJECT_FILTERED, 0) as { value: string } | undefined;
      expect(filteredRow?.value).toBe(JSON.stringify({ nodeId: TARGET }));
    });

    it("text carrier refs stay existence-lenient (PB2 legacy encodings ride the log)", () => {
      const store = seededStore();
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_TEXT, value: { nodeId: GHOST } }, 1727200005000));
      expect(valueRow(store, SCHEMA_TEXT)?.value).toBe(JSON.stringify({ nodeId: GHOST }));
    });

    it("unknown schema ids store unchecked (property.set has no schema FK)", () => {
      const store = seededStore();
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_UNKNOWN, value: { anything: true }, idx: 7 }, 1727200005000));
      expect(valueRow(store, SCHEMA_UNKNOWN, 7)?.value).toBe(JSON.stringify({ anything: true }));
    });
  });

  describe("PB1: broken-target rule (keep-value + keep-edge)", () => {
    function linkOwnerToTarget(store: Store): void {
      store.apply(
        env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_OBJECT_FILTERED, value: { nodeId: TARGET } }, 1727200005000),
      );
    }

    it("permanent delete keeps the surviving source's value AND its derived edge", () => {
      const store = seededStore();
      linkOwnerToTarget(store);
      expect(edgeRows(store, OWNER)).toEqual([{ target_id: TARGET, type: "property" }]);
      store.apply(env("object.delete", { objectId: TARGET, permanent: true }, 1727200006000));
      // Keep-value: the property_value row survives.
      expect(valueRow(store, SCHEMA_OBJECT_FILTERED)?.value).toBe(JSON.stringify({ nodeId: TARGET }));
      // Keep-edge: the derived row survives (no transient resurrection — a
      // rebuild re-derives the identical row instead of dropping it).
      expect(edgeRows(store, OWNER)).toEqual([{ target_id: TARGET, type: "property" }]);
    });

    it("rebuildEdges never drops a broken ref: re-deriving after delete is identical", () => {
      const store = seededStore();
      linkOwnerToTarget(store);
      const before = store.database
        .prepare("SELECT id, target_id, type, verb FROM edge WHERE source_id = ?")
        .all(OWNER) as Array<{ id: string }>;
      store.apply(env("object.delete", { objectId: TARGET, permanent: true }, 1727200006000));
      rebuildEdges(store.database, OWNER, new Date(1727200008000).toISOString());
      const after = store.database
        .prepare("SELECT id, target_id, type, verb FROM edge WHERE source_id = ?")
        .all(OWNER) as Array<{ id: string }>;
      expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    });

    it("soft delete keeps value + edge; restore heals the backlink set", () => {
      const store = seededStore();
      linkOwnerToTarget(store);
      store.apply(env("object.delete", { objectId: TARGET }, 1727200006000));
      expect(valueRow(store, SCHEMA_OBJECT_FILTERED)?.value).toBe(JSON.stringify({ nodeId: TARGET }));
      expect(edgeRows(store, OWNER)).toEqual([{ target_id: TARGET, type: "property" }]);
      // While trashed the backlink still resolves (target row survives).
      const backlinksWhileTrashed = store.backlinks(TARGET).map((row) => (row as { source_id: string }).source_id);
      expect(backlinksWhileTrashed).toContain(OWNER);
      store.apply(env("object.restore", { objectId: TARGET }, 1727200007000));
      const backlinks = store.backlinks(TARGET).map((row) => (row as { source_id: string }).source_id);
      expect(backlinks).toContain(OWNER);
      expect(valueRow(store, SCHEMA_OBJECT_FILTERED)?.value).toBe(JSON.stringify({ nodeId: TARGET }));
    });

    it("deleting the SOURCE drops its outgoing edges with it", () => {
      const store = seededStore();
      linkOwnerToTarget(store);
      store.apply(env("object.delete", { objectId: OWNER, permanent: true }, 1727200006000));
      expect(edgeRows(store, OWNER)).toEqual([]);
      expect(valueRow(store, SCHEMA_OBJECT_FILTERED)).toBeUndefined();
    });
  });
});
