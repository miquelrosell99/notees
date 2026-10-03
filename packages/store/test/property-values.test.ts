/**
 * Property-value lifecycle (§34.32 register, correctness batch):
 *
 *  - PB2 one-shape-per-type: the property.set applier validates the value
 *    against the schema type (text = string-or-reference, date/object =
 *    node reference, date_range = {start,end} of references), normalizes
 *    legacy bare-uuid references to {nodeId}, and fails loud on mismatch;
 *    unknown schema ids store unchecked (property.set has no schema FK).
 *  - PB2 unset-deletes-carrier: property.unset of a node-backed text value
 *    trashes the carrier block (trash + retention, SCHEMA.md), guarded by
 *    exclusivity, parentage, and liveness; object/schema-less unsets never
 *    delete; the "promote to block" gesture composes unset + object.restore.
 *  - PG4 extends-aware bindings: effective resolution walks class_extends
 *    (own binding → shortest extends-path → earliest assignment HLC).
 *  - PC2 typed defaults: class.property.set fails loud on a wrong-typed
 *    defaultValue; the effective read drops a stored default that no longer
 *    matches the schema type.
 *
 * Runs against BOTH shipped adapters, like the main store suite.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import initSqlJs, { type SqlJsStatic } from "sql.js";

import { newEnvelope, type ContentAst, type Envelope } from "@notees/protocol";

import {
  NotFoundError,
  PropertyValueShapeError,
  Store,
  type StoreBackend,
} from "../src/index.js";
import { betterSqlite3Backend } from "../src/adapters/better-sqlite3.js";
import { sqljsBackend } from "../src/adapters/sqljs.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

const OWNER = "0192a000-0000-7000-8000-000000000010";
const CARRIER = "0192a000-0000-7000-8000-000000000020";
const CARRIER_CHILD = "0192a000-0000-7000-8000-000000000021";
const OTHER_PAGE = "0192a000-0000-7000-8000-000000000030";
const SCHEMA_TEXT = "0192a000-0000-7000-8000-0000000000a1";
const SCHEMA_DATE = "0192a000-0000-7000-8000-0000000000a2";
const SCHEMA_RANGE = "0192a000-0000-7000-8000-0000000000a3";
const SCHEMA_OBJECT = "0192a000-0000-7000-8000-0000000000a4";
const SCHEMA_NUMBER = "0192a000-0000-7000-8000-0000000000a5";
const DATE_NODE = "0192a000-0000-7000-8000-0000000000b1";

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
    deviceId: "test-device-props",
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
      const dir = mkdtempSync(join(tmpdir(), "notees-props-test-"));
      tmpDirs.push(dir);
      return betterSqlite3Backend(join(dir, "store.db"));
    },
  },
];

describe.each(adapters)("$name", ({ makeBackend }) => {
  function makeStore(): Store {
    return Store.open(makeBackend());
  }

  /** Owner page + the four schemas the suite writes through. */
  function seededStore(): Store {
    const store = makeStore();
    store.apply(env("object.create", { objectId: OWNER, contentAst: text("Owner") }, 1727200000000));
    store.apply(
      env("propertySchema.create", { propertySchemaId: SCHEMA_TEXT, name: "notes", type: "text" }, 1727200000100),
    );
    store.apply(
      env("propertySchema.create", { propertySchemaId: SCHEMA_DATE, name: "when", type: "date" }, 1727200000100),
    );
    store.apply(
      env("propertySchema.create", { propertySchemaId: SCHEMA_RANGE, name: "span", type: "date_range" }, 1727200000100),
    );
    store.apply(
      env("propertySchema.create", { propertySchemaId: SCHEMA_OBJECT, name: "who", type: "object" }, 1727200000100),
    );
    store.apply(
      env("propertySchema.create", { propertySchemaId: SCHEMA_NUMBER, name: "count", type: "number" }, 1727200000100),
    );
    return store;
  }

  function createCarrier(store: Store, physical: number, parentId = OWNER, id = CARRIER): void {
    store.apply(env("object.create", { objectId: id, parentId, contentAst: text("carrier body") }, physical));
  }

  function valueRow(store: Store, schemaId: string, idx = 0): { value: string } | undefined {
    return store.database
      .prepare("SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = ?")
      .get(OWNER, schemaId, idx) as { value: string } | undefined;
  }

  describe("PB2: one-shape-per-type at the property.set write path", () => {
    it("text accepts a scalar string (the citekey shape) and a {nodeId} reference", () => {
      const store = seededStore();
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_TEXT, value: "kuhn1962" }, 1727200001000));
      expect(valueRow(store, SCHEMA_TEXT)?.value).toBe(JSON.stringify("kuhn1962"));
      createCarrier(store, 1727200001100, OWNER, "0192a000-0000-7000-8000-000000000022");
      store.apply(
        env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_TEXT, value: { nodeId: "0192a000-0000-7000-8000-000000000022" } }, 1727200001200),
      );
      expect(valueRow(store, SCHEMA_TEXT)?.value).toBe(
        JSON.stringify({ nodeId: "0192a000-0000-7000-8000-000000000022" }),
      );
    });

    it("text rejects non-string non-reference shapes fail-loud", () => {
      const store = seededStore();
      for (const bad of [42, true, ["x"], { nope: 1 }, { nodeId: 5 }]) {
        expect(() =>
          store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_TEXT, value: bad }, 1727200001000)),
        ).toThrow(PropertyValueShapeError);
      }
    });

    it("date/object accept node references and normalize a legacy bare uuid; scalars fail loud", () => {
      const store = seededStore();
      store.apply(env("object.create", { objectId: DATE_NODE, contentAst: text("2026") }, 1727200000900));
      // Canonical ref shape.
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_DATE, value: { nodeId: DATE_NODE } }, 1727200001000));
      expect(valueRow(store, SCHEMA_DATE)?.value).toBe(JSON.stringify({ nodeId: DATE_NODE }));
      // Legacy bare uuid normalizes to the reference shape.
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_DATE, value: DATE_NODE }, 1727200001100));
      expect(valueRow(store, SCHEMA_DATE)?.value).toBe(JSON.stringify({ nodeId: DATE_NODE }));
      // A date-looking string is NOT a reference — dates are nodes.
      expect(() =>
        store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_DATE, value: "2026-09-27" }, 1727200001200)),
      ).toThrow(PropertyValueShapeError);
      expect(() =>
        store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_OBJECT, value: "not-a-reference" }, 1727200001200)),
      ).toThrow(PropertyValueShapeError);
    });

    it("date_range accepts {start,end} references, either side open; bad sides fail loud", () => {
      const store = seededStore();
      store.apply(env("object.create", { objectId: DATE_NODE, contentAst: text("2026") }, 1727200000900));
      store.apply(
        env(
          "property.set",
          { objectId: OWNER, propertySchemaId: SCHEMA_RANGE, value: { start: DATE_NODE, end: null } },
          1727200001000,
        ),
      );
      expect(valueRow(store, SCHEMA_RANGE)?.value).toBe(
        JSON.stringify({ start: { nodeId: DATE_NODE }, end: null }),
      );
      expect(() =>
        store.apply(
          env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_RANGE, value: "2026" }, 1727200001100),
        ),
      ).toThrow(PropertyValueShapeError);
      expect(() =>
        store.apply(
          env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_RANGE, value: { start: 42, end: null } }, 1727200001100),
        ),
      ).toThrow(PropertyValueShapeError);
    });

    it("null values bypass shape validation (a cleared slot)", () => {
      const store = seededStore();
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_DATE, value: null }, 1727200001000));
      expect(valueRow(store, SCHEMA_DATE)?.value).toBe("null");
    });

    it("unknown schema ids store unchecked (property.set has no schema FK)", () => {
      const store = seededStore();
      const loose = "0192a000-0000-7000-8000-0000000000c9";
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: loose, value: { anything: true } }, 1727200001000));
      expect(valueRow(store, loose)?.value).toBe(JSON.stringify({ anything: true }));
    });
  });

  describe("PB2: unset deletes the carrier (trash + retention)", () => {
    function trashed(store: Store, id: string): boolean {
      return (
        store.database.prepare("SELECT 1 FROM trash WHERE node_id = ?").get(id) !== undefined
      );
    }
    function active(store: Store, id: string): boolean {
      const row = store.database.prepare("SELECT is_active AS a FROM node WHERE id = ?").get(id) as
        | { a: number }
        | undefined;
      return row?.a === 1;
    }

    it("unsetting a node-backed text value trashes the carrier and its subtree", () => {
      const store = seededStore();
      createCarrier(store, 1727200001000);
      store.apply(
        env("object.create", { objectId: CARRIER_CHILD, parentId: CARRIER, contentAst: text("nested") }, 1727200001100),
      );
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_TEXT, value: { nodeId: CARRIER } }, 1727200001200));
      store.apply(env("property.unset", { objectId: OWNER, propertySchemaId: SCHEMA_TEXT, idx: 0 }, 1727200001300));
      expect(valueRow(store, SCHEMA_TEXT)).toBeUndefined();
      expect(active(store, CARRIER)).toBe(false);
      expect(active(store, CARRIER_CHILD)).toBe(false);
      expect(trashed(store, CARRIER)).toBe(true);
      expect(trashed(store, CARRIER_CHILD)).toBe(false); // one trash row, at the carrier
    });

    it("the legacy bare-uuid carrier shape is deleted too", () => {
      const store = seededStore();
      createCarrier(store, 1727200001000);
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_TEXT, value: CARRIER }, 1727200001200));
      store.apply(env("property.unset", { objectId: OWNER, propertySchemaId: SCHEMA_TEXT, idx: 0 }, 1727200001300));
      expect(active(store, CARRIER)).toBe(false);
      expect(trashed(store, CARRIER)).toBe(true);
    });

    it("promote to block: object.restore revives the just-trashed carrier as an ordinary child", () => {
      const store = seededStore();
      createCarrier(store, 1727200001000);
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_TEXT, value: { nodeId: CARRIER } }, 1727200001200));
      // The client-level promote gesture composes exactly these two ops.
      store.apply(env("property.unset", { objectId: OWNER, propertySchemaId: SCHEMA_TEXT, idx: 0 }, 1727200001300));
      store.apply(env("object.restore", { objectId: CARRIER }, 1727200001400));
      expect(active(store, CARRIER)).toBe(true);
      expect(trashed(store, CARRIER)).toBe(false);
      const carrier = store.getNode(CARRIER);
      expect(carrier?.parent_id).toBe(OWNER);
      expect(carrier?.is_active).toBe(1);
    });

    it("scalar text values (citekey-style) carry no carrier — nothing is trashed", () => {
      const store = seededStore();
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_TEXT, value: "kuhn1962" }, 1727200001200));
      store.apply(env("property.unset", { objectId: OWNER, propertySchemaId: SCHEMA_TEXT, idx: 0 }, 1727200001300));
      expect(trashed(store, OWNER)).toBe(false);
      expect(active(store, OWNER)).toBe(true);
    });

    it("a carrier still referenced from another slot is NOT trashed", () => {
      const store = seededStore();
      createCarrier(store, 1727200001000);
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_TEXT, value: { nodeId: CARRIER } }, 1727200001200));
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_TEXT, value: { nodeId: CARRIER }, idx: 1 }, 1727200001250));
      store.apply(env("property.unset", { objectId: OWNER, propertySchemaId: SCHEMA_TEXT, idx: 0 }, 1727200001300));
      expect(active(store, CARRIER)).toBe(true);
      expect(trashed(store, CARRIER)).toBe(false);
      // Detaching the remaining reference trashes it.
      store.apply(env("property.unset", { objectId: OWNER, propertySchemaId: SCHEMA_TEXT, idx: 1 }, 1727200001400));
      expect(active(store, CARRIER)).toBe(false);
      expect(trashed(store, CARRIER)).toBe(true);
    });

    it("a referenced node that is not a child of the owner is not trashed", () => {
      const store = seededStore();
      store.apply(env("object.create", { objectId: OTHER_PAGE, contentAst: text("free page") }, 1727200001000));
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_TEXT, value: { nodeId: OTHER_PAGE } }, 1727200001200));
      store.apply(env("property.unset", { objectId: OWNER, propertySchemaId: SCHEMA_TEXT, idx: 0 }, 1727200001300));
      expect(active(store, OTHER_PAGE)).toBe(true);
      expect(trashed(store, OTHER_PAGE)).toBe(false);
    });

    it("object-typed values never delete their target on unset", () => {
      const store = seededStore();
      store.apply(env("object.create", { objectId: OTHER_PAGE, contentAst: text("free page") }, 1727200001000));
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_OBJECT, value: { nodeId: OTHER_PAGE } }, 1727200001200));
      store.apply(env("property.unset", { objectId: OWNER, propertySchemaId: SCHEMA_OBJECT, idx: 0 }, 1727200001300));
      expect(active(store, OTHER_PAGE)).toBe(true);
    });

    it("a stale unset (lower HLC) neither removes the value nor trashes the carrier", () => {
      const store = seededStore();
      createCarrier(store, 1727200001000);
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_TEXT, value: { nodeId: CARRIER } }, 1727200001200));
      store.apply(env("property.unset", { objectId: OWNER, propertySchemaId: SCHEMA_TEXT, idx: 0 }, 1727200001100));
      expect(valueRow(store, SCHEMA_TEXT)).toBeDefined();
      expect(active(store, CARRIER)).toBe(true);
    });
  });

  describe("PG4: extends-aware binding resolution", () => {
    const BASE = "00000000-0000-7000-8000-0000000000c1";
    const MID = "00000000-0000-7000-8000-0000000000c2";
    const LEAF = "00000000-0000-7000-8000-0000000000c3";
    const MID_B = "00000000-0000-7000-8000-0000000000c4";
    const LEAF_B = "00000000-0000-7000-8000-0000000000c5";
    const SCHEMA = "0192a000-0000-7000-8000-0000000000d1";

    /** BASE <- MID <- LEAF chain, one text schema bound on BASE. */
    function chainStore(bindOn: string[]): Store {
      const store = seededStore();
      for (const [id, name, at] of [
        [BASE, "Base", 1727200001000],
        [MID, "Mid", 1727200001100],
        [LEAF, "Leaf", 1727200001200],
      ] as const) {
        store.apply(env("class.create", { classId: id, contentAst: text(name) }, at));
      }
      store.apply(env("class.setExtends", { classId: MID, parentClassIds: [BASE] }, 1727200001300));
      store.apply(env("class.setExtends", { classId: LEAF, parentClassIds: [MID] }, 1727200001400));
      store.apply(
        env("propertySchema.create", { propertySchemaId: SCHEMA, name: "genre", type: "text" }, 1727200001500),
      );
      for (const [i, classId] of bindOn.entries()) {
        store.apply(
          env("class.property.set", { classId, propertySchemaId: SCHEMA, sequence: i, defaultValue: `dft-${i}` }, 1727200001600 + i),
        );
      }
      return store;
    }

    function assignClass(store: Store, classId: string, physical: number): void {
      // Class assignment rides the re-issued object.create OR-Set add; one
      // envelope per class so the assignment HLCs order the winners.
      store.apply(env("object.create", { objectId: OWNER, contentAst: text("Owner"), classIds: [classId] }, physical));
    }

    it("a binding inherited through extends derives for the subclass's nodes (boundBy = the ancestor)", () => {
      const store = chainStore([BASE]);
      assignClass(store, LEAF, 1727200002000);
      const effective = store.getEffectiveProperties(OWNER);
      expect(effective).toEqual([
        expect.objectContaining({
          propertySchemaId: SCHEMA,
          value: "dft-0",
          source: "default",
          boundBy: BASE,
        }),
      ]);
    });

    it("an own binding beats an inherited one regardless of assignment order", () => {
      const store = chainStore([BASE, MID]);
      assignClass(store, LEAF, 1727200002000);
      const winner = store.getEffectiveProperties(OWNER).find((r) => r.propertySchemaId === SCHEMA);
      expect(winner).toMatchObject({ value: "dft-1", source: "default", boundBy: MID });
    });

    it("shortest extends-path wins: MID's binding beats BASE's for a LEAF node", () => {
      const store = chainStore([BASE, MID]);
      assignClass(store, LEAF, 1727200002000);
      const winner = store.getEffectiveProperties(OWNER).find((r) => r.propertySchemaId === SCHEMA);
      // MID is distance 1 from LEAF, BASE is distance 2 — MID supplies the default.
      expect(winner).toMatchObject({ value: "dft-1", boundBy: MID });
    });

    it("diamond tie at equal distance resolves by earliest class-assignment HLC", () => {
      const store = seededStore();
      for (const [id, name, at] of [
        [BASE, "Base", 1727200001000],
        [MID, "MidA", 1727200001100],
        [MID_B, "MidB", 1727200001150],
        [LEAF, "LeafA", 1727200001200],
        [LEAF_B, "LeafB", 1727200001250],
      ] as const) {
        store.apply(env("class.create", { classId: id, contentAst: text(name) }, at));
      }
      store.apply(env("class.setExtends", { classId: LEAF, parentClassIds: [MID] }, 1727200001300));
      store.apply(env("class.setExtends", { classId: LEAF_B, parentClassIds: [MID_B] }, 1727200001300));
      store.apply(env("propertySchema.create", { propertySchemaId: SCHEMA, name: "genre", type: "text" }, 1727200001400));
      store.apply(env("class.property.set", { classId: MID, propertySchemaId: SCHEMA, sequence: 0, defaultValue: "from-A" }, 1727200001500));
      store.apply(env("class.property.set", { classId: MID_B, propertySchemaId: SCHEMA, sequence: 0, defaultValue: "from-B" }, 1727200001500));
      // LEAF assigned first (earliest add HLC) — its path to MID wins the tie.
      assignClass(store, LEAF, 1727200002000);
      assignClass(store, LEAF_B, 1727200002100);
      expect(store.getEffectiveProperties(OWNER).find((r) => r.propertySchemaId === SCHEMA)).toMatchObject({
        value: "from-A",
        boundBy: MID,
      });
      // Reversed assignment order on another node flips the winner.
      const other = "0192a000-0000-7000-8000-0000000000e1";
      store.apply(env("object.create", { objectId: other, contentAst: text("Other") }, 1727200001900));
      store.apply(env("object.create", { objectId: other, contentAst: text("Other"), classIds: [LEAF_B] }, 1727200002000));
      store.apply(env("object.create", { objectId: other, contentAst: text("Other"), classIds: [LEAF] }, 1727200002100));
      expect(store.getEffectiveProperties(other).find((r) => r.propertySchemaId === SCHEMA)).toMatchObject({
        value: "from-B",
        boundBy: MID_B,
      });
    });

    it("inherited binding metadata (required/readonly) surfaces on authored rows", () => {
      const store = chainStore([BASE]);
      // Re-bind with flags on BASE.
      store.apply(
        env("class.property.set", { classId: BASE, propertySchemaId: SCHEMA, required: true, readonly: true }, 1727200001700),
      );
      store.apply(env("object.create", { objectId: OWNER, contentAst: text("Owner"), classIds: [LEAF] }, 1727200002000));
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA, value: "mine" }, 1727200002100));
      const row = store.getEffectiveProperties(OWNER).find((r) => r.propertySchemaId === SCHEMA);
      expect(row).toMatchObject({
        value: "mine",
        source: "authored",
        boundBy: BASE,
        required: true,
        readonly: true,
      });
    });
  });

  describe("PC2: typed, validated defaultValue", () => {
    const CLS = "00000000-0000-7000-8000-0000000000c1";

    function boundStore(type: string, schemaId: string): Store {
      const store = seededStore();
      store.apply(env("class.create", { classId: CLS, contentAst: text("C") }, 1727200001000));
      store.apply(
        env("propertySchema.create", { propertySchemaId: schemaId, name: "slot", type }, 1727200001100),
      );
      return store;
    }

    it("class.property.set fails loud on a wrong-typed default", () => {
      const store = boundStore("text", SCHEMA_TEXT);
      expect(() =>
        store.apply(env("class.property.set", { classId: CLS, propertySchemaId: SCHEMA_TEXT, defaultValue: true }, 1727200001200)),
      ).toThrow(PropertyValueShapeError);
      expect(() =>
        store.apply(env("class.property.set", { classId: CLS, propertySchemaId: SCHEMA_TEXT, defaultValue: { nodeId: OWNER } }, 1727200001200)),
      ).toThrow(PropertyValueShapeError);
    });

    it("node-typed schemas reject non-null defaults", () => {
      const store = boundStore("object", SCHEMA_OBJECT);
      expect(() =>
        store.apply(env("class.property.set", { classId: CLS, propertySchemaId: SCHEMA_OBJECT, defaultValue: { nodeId: OWNER } }, 1727200001200)),
      ).toThrow(PropertyValueShapeError);
      // JSON null IS a real default for any type.
      store.apply(env("class.property.set", { classId: CLS, propertySchemaId: SCHEMA_OBJECT, defaultValue: null }, 1727200001200));
      const row = store.database
        .prepare("SELECT default_value FROM class_property WHERE class_id = ? AND property_schema_id = ?")
        .get(CLS, SCHEMA_OBJECT) as { default_value: string };
      expect(row.default_value).toBe("null");
    });

    it("typed defaults store: string for text/select, number for number, boolean for boolean", () => {
      const store = boundStore("number", SCHEMA_NUMBER);
      store.apply(env("class.property.set", { classId: CLS, propertySchemaId: SCHEMA_NUMBER, defaultValue: 7 }, 1727200001200));
      const owner2 = "0192a000-0000-7000-8000-0000000000e2";
      store.apply(env("object.create", { objectId: owner2, contentAst: text("N"), classIds: [CLS] }, 1727200002000));
      expect(store.getEffectiveProperties(owner2)).toEqual([
        expect.objectContaining({ value: 7, source: "default", boundBy: CLS }),
      ]);
    });

    it("a default that drifted out of match with the schema type yields no default at read", () => {
      const store = boundStore("number", SCHEMA_NUMBER);
      store.apply(env("class.property.set", { classId: CLS, propertySchemaId: SCHEMA_NUMBER, defaultValue: 7 }, 1727200001200));
      // PG3-style drift: delete + recreate the schema under the SAME id as text.
      store.apply(env("propertySchema.delete", { propertySchemaId: SCHEMA_NUMBER }, 1727200001300));
      store.apply(
        env("propertySchema.create", { propertySchemaId: SCHEMA_NUMBER, name: "slot", type: "text" }, 1727200001400),
      );
      const owner2 = "0192a000-0000-7000-8000-0000000000e2";
      store.apply(env("object.create", { objectId: owner2, contentAst: text("N"), classIds: [CLS] }, 1727200002000));
      // The binding row survives; the wrong-typed stored default is dropped.
      expect(store.getEffectiveProperties(owner2)).toEqual([]);
    });

    it("unknown schema id skips default validation (no schema FK)", () => {
      const store = seededStore();
      store.apply(env("class.create", { classId: CLS, contentAst: text("C") }, 1727200001000));
      const loose = "0192a000-0000-7000-8000-0000000000c9";
      expect(() =>
        store.apply(env("class.property.set", { classId: CLS, propertySchemaId: loose, defaultValue: { anything: true } }, 1727200001200)),
      ).not.toThrow();
    });
  });

  describe("restore corner: promotePropertyCarrier against a non-trashed carrier", () => {
    it("object.restore of a carrier another slot still references is a safe no-op", () => {
      const store = seededStore();
      createCarrier(store, 1727200001000);
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_TEXT, value: { nodeId: CARRIER } }, 1727200001200));
      store.apply(env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_TEXT, value: { nodeId: CARRIER }, idx: 1 }, 1727200001250));
      // The exclusivity guard kept the carrier alive through idx 0's unset;
      // the promote gesture's restore step no-ops on the live carrier.
      store.apply(env("property.unset", { objectId: OWNER, propertySchemaId: SCHEMA_TEXT, idx: 0 }, 1727200001300));
      store.apply(env("object.restore", { objectId: CARRIER }, 1727200001400));
      const carrier = store.getNode(CARRIER);
      expect(carrier?.is_active).toBe(1);
      expect(carrier?.parent_id).toBe(OWNER);
    });

    it("restore of a permanently deleted node surfaces not_found (existing contract)", () => {
      const store = seededStore();
      createCarrier(store, 1727200001000);
      store.apply(env("object.delete", { objectId: CARRIER, permanent: true }, 1727200001100));
      expect(() => store.apply(env("object.restore", { objectId: CARRIER }, 1727200001200))).toThrow(
        NotFoundError,
      );
    });
  });

  describe("PG12: propertyValueCarriers (the PropertyReferencesSection read)", () => {
    it("lists active nodes with authored slots; trashed and unvalued nodes stay out", () => {
      const store = seededStore();
      createCarrier(store, 1727200001000, OWNER, CARRIER);
      createCarrier(store, 1727200001050, OWNER, CARRIER_CHILD);
      createCarrier(store, 1727200001060, OWNER, OTHER_PAGE);
      store.apply(
        env("property.set", { objectId: OWNER, propertySchemaId: SCHEMA_TEXT, value: "owner-slot" }, 1727200001100),
      );
      store.apply(
        env("property.set", { objectId: CARRIER, propertySchemaId: SCHEMA_TEXT, value: "carrier-a" }, 1727200001150),
      );
      store.apply(
        env("property.set", { objectId: CARRIER, propertySchemaId: SCHEMA_TEXT, value: "carrier-b", idx: 1 }, 1727200001160),
      );
      // A different schema never lists.
      store.apply(
        env("property.set", { objectId: OTHER_PAGE, propertySchemaId: SCHEMA_NUMBER, value: 7 }, 1727200001170),
      );
      // A trashed carrier drops out.
      store.apply(
        env("property.set", { objectId: CARRIER_CHILD, propertySchemaId: SCHEMA_TEXT, value: "doomed" }, 1727200001180),
      );
      store.apply(env("object.delete", { objectId: CARRIER_CHILD, permanent: false }, 1727200001190));

      const carriers = store.propertyValueCarriers(SCHEMA_TEXT);
      expect(carriers.map((entry) => entry.node.id)).toEqual([OWNER, CARRIER]);
      const carrierEntry = carriers.find((entry) => entry.node.id === CARRIER);
      expect(carrierEntry?.slots).toEqual([
        { idx: 0, value: "carrier-a", metadata: null },
        { idx: 1, value: "carrier-b", metadata: null },
      ]);
      // Qualifier metadata rides along for the value column.
      store.apply(
        env(
          "property.set",
          { objectId: OWNER, propertySchemaId: SCHEMA_TEXT, value: "owner-slot", metadata: { since: "2020" } },
          1727200001200,
        ),
      );
      const ownerEntry = store.propertyValueCarriers(SCHEMA_TEXT).find((entry) => entry.node.id === OWNER);
      expect(ownerEntry?.slots[0]?.metadata).toEqual({ since: "2020" });

      // Unknown schema → empty; the other schema's owner never lists.
      expect(store.propertyValueCarriers("0192a000-0000-7000-8000-0000000000ff")).toEqual([]);
      expect(store.propertyValueCarriers(SCHEMA_NUMBER).map((entry) => entry.node.id)).toEqual([OTHER_PAGE]);
    });
  });
});
