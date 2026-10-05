/**
 * §34.56 property-wire batch — PG5 (per-element value UUID + OR-Set
 * multi-values), PC4 (class_property.active), PC6 (date-node-backed
 * qualifiers): store semantics asserted on BOTH shipped adapters, plus
 * forward/backward fixture convergence (single global log, both delivery
 * orders → byte-identical derived state).
 *
 * LOCKSTEP-PENDING: the new payload keys (elementId, active) and the
 * qualifier ref shape ship inert — no TS writer emits them until the GTK
 * m6+/Flutter m16+ releases parse them (§34.54/§34.56 law). These tests
 * exercise the appliers directly.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import initSqlJs, { type SqlJsStatic } from "sql.js";

import { newEnvelope, type Envelope } from "@notees/protocol";
import { dayNodeId } from "@notees/domain";

import { Store, type StoreBackend } from "../src/index.js";
import { betterSqlite3Backend } from "../src/adapters/better-sqlite3.js";
import { sqljsBackend } from "../src/adapters/sqljs.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR_A = "0192a000-0000-7000-8000-000000000002";
const ACTOR_B = "0192a000-0000-7000-8000-000000000003";

const PAGE = "0192a000-0000-7000-8000-000000000010";
const TARGET = "0192a000-0000-7000-8000-000000000020";
const CLASS_A = "0192a000-0000-7000-8000-0000000000c1";
const CLASS_B = "0192a000-0000-7000-8000-0000000000c2";
const SCHEMA_MULTI_TEXT = "0192a000-0000-7000-8000-0000000000a1";
const SCHEMA_SINGLE_TEXT = "0192a000-0000-7000-8000-0000000000a2";
const SCHEMA_QUALIFIED = "0192a000-0000-7000-8000-0000000000a3";
const SCHEMA_PLAIN = "0192a000-0000-7000-8000-0000000000a4";
const ELEM_A = "0192a000-0000-7000-8000-0000000000e1";
const ELEM_B = "0192a000-0000-7000-8000-0000000000e2";
const ELEM_C = "0192a000-0000-7000-8000-0000000000e3";
const CARRIER = "0192a000-0000-7000-8000-0000000000f1";

function env(
  opType: string,
  payload: Record<string, unknown>,
  physical: number,
  logical = 0,
  actor = ACTOR_A,
): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: actor,
    deviceId: "test-device-elements",
    hlc: { physical, logical },
    opType,
    payload,
    timestamp: new Date(physical).toISOString(),
  });
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
      const dir = mkdtempSync(join(tmpdir(), "notees-elements-test-"));
      tmpDirs.push(dir);
      return betterSqlite3Backend(join(dir, "store.db"));
    },
  },
];

/** Whole-database dump for convergence checks (deterministic ordering).
 *  search_index_docid is excluded: its docid is an insertion-order surrogate
 *  key, not semantic state (cross-ORDER comparisons of legal replays may
 *  legitimately renumber it; the indexed text itself is compared). */
function dumpDb(store: Store): Record<string, unknown[]> {
  const tables = (
    store.database
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         AND name NOT IN (
           'search_index_data', 'search_index_idx', 'search_index_config',
           'search_index_docsize', 'search_index_content',
           'search_index_segments', 'search_index_segdir', 'search_index_stat',
           'search_index_docid'
         )
         AND name != 'sync_state' AND name != 'applied_envelope'
         ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
  const dump: Record<string, unknown[]> = {};
  for (const table of tables) {
    const rows = store.database.prepare(`SELECT * FROM "${table}"`).all() as Record<
      string,
      unknown
    >[];
    rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    dump[table] = rows;
  }
  return dump;
}

describe.each(adapters)("$name", ({ makeBackend }) => {
  function makeStore(): Store {
    return Store.open(makeBackend());
  }

  /** Owner page + target + class + the schema menu the suite writes through. */
  function seededStore(): Store {
    const store = makeStore();
    let ts = 1727200000000;
    const step = (): number => (ts += 100);
    store.apply(env("object.create", { objectId: PAGE, contentAst: [{ type: "text", text: "Page" }] }, step()));
    store.apply(env("object.create", { objectId: TARGET, contentAst: [{ type: "text", text: "Target" }] }, step()));
    store.apply(env("object.create", { objectId: CARRIER, parentId: PAGE, contentAst: [{ type: "text", text: "carrier body" }] }, step()));
    store.apply(env("class.create", { classId: CLASS_A, contentAst: [{ type: "text", text: "ClassA" }] }, step()));
    store.apply(env("class.create", { classId: CLASS_B, contentAst: [{ type: "text", text: "ClassB" }] }, step()));
    store.applyMany([
      env("propertySchema.create", { propertySchemaId: SCHEMA_MULTI_TEXT, name: "tags", type: "text", multi: true }, step()),
      env("propertySchema.create", { propertySchemaId: SCHEMA_SINGLE_TEXT, name: "title", type: "text" }, step()),
      env("propertySchema.create", { propertySchemaId: SCHEMA_QUALIFIED, name: "member", type: "object", multi: true, dateQualified: true }, step()),
      env("propertySchema.create", { propertySchemaId: SCHEMA_PLAIN, name: "plain", type: "object" }, step()),
    ]);
    return store;
  }

  const authoredValues = (store: Store, schemaId: string): Array<{ idx: number; value: unknown; elementId: string }> =>
    store
      .getEffectiveProperties(PAGE)
      .filter((row) => row.propertySchemaId === schemaId && row.source === "authored")
      .map((row) => ({ idx: row.idx, value: row.value, elementId: row.elementId }));

  describe("PG5 — element identity + OR-Set multi-values", () => {
    it("element adds at the same idx coexist, ordered by (idx, element id)", () => {
      const store = seededStore();
      let ts = 1727200010000;
      store.apply(env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, value: "alpha", elementId: ELEM_A, idx: 0 }, (ts += 100)));
      store.apply(env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, value: "beta", elementId: ELEM_B, idx: 1 }, (ts += 100), 0, ACTOR_B));
      store.apply(env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, value: "gamma", elementId: ELEM_C, idx: 1 }, (ts += 100)));
      // ELEM_B < ELEM_C: the idx-1 tie breaks on the element id.
      expect(authoredValues(store, SCHEMA_MULTI_TEXT)).toEqual([
        { idx: 0, value: "alpha", elementId: ELEM_A },
        { idx: 1, value: "beta", elementId: ELEM_B },
        { idx: 1, value: "gamma", elementId: ELEM_C },
      ]);
      // The row ids ARE the element ids.
      const rows = store.database
        .prepare("SELECT id FROM property_value WHERE node_id = ? ORDER BY id")
        .all(PAGE) as Array<{ id: string }>;
      expect(rows.map((r) => r.id).sort()).toEqual([ELEM_A, ELEM_B, ELEM_C].sort());
    });

    it("element remove tombstones the element; a newer re-add revives it (add-wins)", () => {
      const store = seededStore();
      let ts = 1727200011000;
      store.apply(env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, value: "beta", elementId: ELEM_B, idx: 1 }, (ts += 100)));
      store.apply(env("property.unset", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, elementId: ELEM_B }, (ts += 100)));
      expect(authoredValues(store, SCHEMA_MULTI_TEXT)).toEqual([]);
      expect(
        (store.database.prepare("SELECT COUNT(*) AS n FROM property_value_element_tombstone").get() as { n: number }).n,
      ).toBe(1);
      // A stale re-add (older than the tombstone) is dropped.
      const stale = store.apply(
        env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, value: "resurrected-old", elementId: ELEM_B, idx: 1 }, ts - 50),
      );
      expect(stale.ignored).toBe(true);
      expect(authoredValues(store, SCHEMA_MULTI_TEXT)).toEqual([]);
      // A newer re-add revives the element.
      store.apply(env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, value: "resurrected", elementId: ELEM_B, idx: 2 }, (ts += 100)));
      expect(authoredValues(store, SCHEMA_MULTI_TEXT)).toEqual([
        { idx: 2, value: "resurrected", elementId: ELEM_B },
      ]);
    });

    it("add wins the exact-HLC tie regardless of actor (membership comparator is HLC-only)", () => {
      const store = seededStore();
      const h = 1727200012000;
      // Add at (h, 0, A); a remove from B at the SAME hlc cannot kill it…
      store.apply(env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, value: "alive", elementId: ELEM_A, idx: 0 }, h, 0, ACTOR_A));
      store.apply(env("property.unset", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, elementId: ELEM_A }, h, 0, ACTOR_B));
      expect(authoredValues(store, SCHEMA_MULTI_TEXT)).toEqual([
        { idx: 0, value: "alive", elementId: ELEM_A },
      ]);
      // …and a re-add at the same hlc as the tombstone revives the element
      // even though the stored tombstone carries a BIGGER actor id — the
      // membership gate compares HLC only.
      store.apply(env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, value: "gone", elementId: ELEM_B, idx: 1 }, h, 0, ACTOR_A));
      store.apply(env("property.unset", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, elementId: ELEM_B }, h, 1, ACTOR_B));
      expect(
        store.database.prepare("SELECT 1 FROM property_value WHERE id = ?").get(ELEM_B),
      ).toBeUndefined(); // the strictly-newer remove won
      const revived = store.apply(
        env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, value: "revived", elementId: ELEM_B, idx: 1 }, h, 1, ACTOR_A),
      );
      expect(revived.ignored).toBe(false);
      expect(authoredValues(store, SCHEMA_MULTI_TEXT)).toEqual([
        { idx: 0, value: "alive", elementId: ELEM_A },
        { idx: 1, value: "revived", elementId: ELEM_B },
      ]);
    });

    it("value LWW per element uses the full (hlc, actor) tuple", () => {
      const store = seededStore();
      let ts = 1727200013000;
      store.apply(env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, value: "first", elementId: ELEM_A, idx: 0 }, (ts += 100), 0, ACTOR_B));
      // Same element, newer HLC from a smaller actor: HLC wins.
      store.apply(env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, value: "second", elementId: ELEM_A, idx: 0 }, (ts += 100), 0, ACTOR_A));
      expect(authoredValues(store, SCHEMA_MULTI_TEXT)).toEqual([
        { idx: 0, value: "second", elementId: ELEM_A },
      ]);
      // A stale full tuple (lower HLC) is dropped.
      const stale = store.apply(
        env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, value: "ancient", elementId: ELEM_A, idx: 0 }, ts - 50),
      );
      expect(stale.ignored).toBe(true);
      expect(authoredValues(store, SCHEMA_MULTI_TEXT)[0]?.value).toBe("second");
    });

    it("the legacy positional path coexists: positional ops address only the deterministic positional element", () => {
      const store = seededStore();
      let ts = 1727200014000;
      store.apply(env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, value: "element", elementId: ELEM_A, idx: 1 }, (ts += 100)));
      store.apply(env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, value: "positional", idx: 1 }, (ts += 100)));
      // Same-idx tie orders by element id: the composite positional id
      // ("…0010:…") sorts before ELEM_A ("…0e1").
      expect(authoredValues(store, SCHEMA_MULTI_TEXT)).toEqual([
        { idx: 1, value: "positional", elementId: `${PAGE}:${SCHEMA_MULTI_TEXT}:1` },
        { idx: 1, value: "element", elementId: ELEM_A },
      ]);
      // A positional unset addresses the whole SLOT positionally: the
      // deterministic positional element dies AND element rows at that idx
      // whose adds are not strictly newer are tombstone-suppressed…
      store.apply(env("property.unset", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, idx: 1 }, (ts += 100)));
      expect(authoredValues(store, SCHEMA_MULTI_TEXT)).toEqual([]);
      // …until a newer element add at the slot lands (add-wins by causality).
      store.apply(env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, value: "element-again", elementId: ELEM_A, idx: 1 }, (ts += 100)));
      expect(authoredValues(store, SCHEMA_MULTI_TEXT)).toEqual([
        { idx: 1, value: "element-again", elementId: ELEM_A },
      ]);
    });

    it("edge rebuild consistency: a removed element's edges vanish with it", () => {
      const store = seededStore();
      let ts = 1727200015000;
      store.apply(env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_PLAIN, value: { nodeId: TARGET }, elementId: ELEM_A, idx: 0 }, (ts += 100)));
      const edgeCount = (): number =>
        (store.database
          .prepare("SELECT COUNT(*) AS n FROM edge WHERE source_id = ? AND type = 'property'")
          .get(PAGE) as { n: number }).n;
      expect(edgeCount()).toBe(1);
      store.apply(env("property.unset", { objectId: PAGE, propertySchemaId: SCHEMA_PLAIN, elementId: ELEM_A }, (ts += 100)));
      expect(edgeCount()).toBe(0);
      // …and the target's backlink stats followed.
      const stats = store.database
        .prepare("SELECT backlink_count FROM node_stats WHERE node_id = ?")
        .get(TARGET) as { backlink_count: number } | undefined;
      expect(stats?.backlink_count ?? 0).toBe(0);
    });

    it("FTS consistency: a removed element's scalar text leaves the index", () => {
      const store = seededStore();
      let ts = 1727200016000;
      store.apply(env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, value: "zzuniqueword", elementId: ELEM_A, idx: 0 }, (ts += 100)));
      expect(store.search("zzuniqueword").map((h) => h.nodeId)).toContain(PAGE);
      store.apply(env("property.unset", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, elementId: ELEM_A }, (ts += 100)));
      expect(store.search("zzuniqueword").map((h) => h.nodeId)).not.toContain(PAGE);
    });

    it("element unset of a node-backed text value trashes the orphaned carrier (PB2 guards)", () => {
      const store = seededStore();
      let ts = 1727200017000;
      store.apply(env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, value: { nodeId: CARRIER }, elementId: ELEM_A, idx: 0 }, (ts += 100)));
      expect(store.getNode(CARRIER)?.is_active).toBe(1);
      store.apply(env("property.unset", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, elementId: ELEM_A }, (ts += 100)));
      expect(store.getNode(CARRIER)?.is_active).toBe(0);
      expect(
        store.database.prepare("SELECT 1 FROM trash WHERE node_id = ?").get(CARRIER),
      ).toBeDefined();
    });

    it("population reads (propertyValueCarriers / scalarPropertyValues) skip tombstoned elements", () => {
      const store = seededStore();
      let ts = 1727200018000;
      store.apply(env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, value: "visible", elementId: ELEM_A, idx: 0 }, (ts += 100)));
      store.apply(env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, value: "hidden", elementId: ELEM_B, idx: 1 }, (ts += 100)));
      store.apply(env("property.unset", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, elementId: ELEM_B }, (ts += 100)));
      const carriers = store.propertyValueCarriers(SCHEMA_MULTI_TEXT);
      expect(carriers).toHaveLength(1);
      expect(carriers[0]?.slots.map((s) => s.value)).toEqual(["visible"]);
      expect(store.scalarPropertyValues(PAGE, SCHEMA_MULTI_TEXT)).toEqual(["visible"]);
    });

    it("an unset addressed at an element under a different (node, schema) is a deterministic no-op", () => {
      const store = seededStore();
      let ts = 1727200019000;
      store.apply(env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, value: "mine", elementId: ELEM_A, idx: 0 }, (ts += 100)));
      store.apply(
        env("property.unset", { objectId: TARGET, propertySchemaId: SCHEMA_MULTI_TEXT, elementId: ELEM_A }, (ts += 100)),
      );
      // The element survives; the tombstone targets (TARGET, schema) only.
      expect(authoredValues(store, SCHEMA_MULTI_TEXT)).toEqual([
        { idx: 0, value: "mine", elementId: ELEM_A },
      ]);
    });

    it("concurrent add/remove at the same HLC converges under EITHER delivery order", () => {
      // The only legally-reorderable ops are genuinely concurrent ones: a
      // same-(hlc) pair may catch up in either order on a fresh replica.
      const results: string[] = [];
      for (const order of ["add-first", "remove-first"] as const) {
        const store = seededStore();
        const h = 1727200019500;
        const add = env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, value: "concurrent", elementId: ELEM_A, idx: 0 }, h, 0, ACTOR_A);
        const remove = env("property.unset", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, elementId: ELEM_A }, h, 0, ACTOR_B);
        store.applyMany(order === "add-first" ? [add, remove] : [remove, add]);
        results.push(JSON.stringify(dumpDb(store)));
      }
      expect(results[1]).toEqual(results[0]);
      // …and the add won the tie: the element is visible in both orders.
      const store = seededStore();
      store.applyMany([
        env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, value: "concurrent", elementId: ELEM_A, idx: 0 }, 1727200019500, 0, ACTOR_A),
        env("property.unset", { objectId: PAGE, propertySchemaId: SCHEMA_MULTI_TEXT, elementId: ELEM_A }, 1727200019500, 0, ACTOR_B),
      ]);
      expect(authoredValues(store, SCHEMA_MULTI_TEXT)).toEqual([
        { idx: 0, value: "concurrent", elementId: ELEM_A },
      ]);
    });
  });

  describe("PC4 — class_property.active", () => {
    it("an inactive binding stops contributing defaults + metadata; the row survives", () => {
      const store = seededStore();
      let ts = 1727200020000;
      store.apply(env("object.create", { objectId: PAGE, classIds: [CLASS_A] }, ts)); // re-issue: OR-Set add
      store.apply(env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA_SINGLE_TEXT, sequence: 3, required: true, defaultValue: "fallback" }, (ts += 100)));
      const before = store.getEffectiveProperties(PAGE).filter((r) => r.propertySchemaId === SCHEMA_SINGLE_TEXT);
      expect(before).toEqual([
        expect.objectContaining({ source: "default", value: "fallback", boundBy: CLASS_A, required: true, sequence: 3 }),
      ]);
      store.apply(env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA_SINGLE_TEXT, active: false }, (ts += 100)));
      expect(store.getEffectiveProperties(PAGE).filter((r) => r.propertySchemaId === SCHEMA_SINGLE_TEXT)).toEqual([]);
      // The ROW survives (soft-unbind, not a removal).
      expect(
        store.database
          .prepare("SELECT active FROM class_property WHERE class_id = ? AND property_schema_id = ?")
          .get(CLASS_A, SCHEMA_SINGLE_TEXT),
      ).toEqual({ active: 0 });
    });

    it("authored values survive an inactive binding (read as unbound, boundBy null)", () => {
      const store = seededStore();
      let ts = 1727200021000;
      store.apply(env("object.create", { objectId: PAGE, classIds: [CLASS_A] }, ts));
      store.apply(env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA_SINGLE_TEXT, defaultValue: "fallback" }, (ts += 100)));
      store.apply(env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA_SINGLE_TEXT, active: false }, (ts += 100)));
      store.apply(env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_SINGLE_TEXT, value: "authored" }, (ts += 100)));
      expect(store.getEffectiveProperties(PAGE).filter((r) => r.propertySchemaId === SCHEMA_SINGLE_TEXT)).toEqual([
        expect.objectContaining({ source: "authored", value: "authored", boundBy: null }),
      ]);
      // Re-enable: the authored value shadows the default again, boundBy back.
      store.apply(env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA_SINGLE_TEXT, active: true }, (ts += 100)));
      expect(store.getEffectiveProperties(PAGE).filter((r) => r.propertySchemaId === SCHEMA_SINGLE_TEXT)).toEqual([
        expect.objectContaining({ source: "authored", value: "authored", boundBy: CLASS_A }),
      ]);
    });

    it("the active flag rides the row LWW (the fixture's enable-loses race)", () => {
      const store = seededStore();
      let ts = 1727200022000;
      store.apply(env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA_SINGLE_TEXT, defaultValue: "fallback" }, (ts += 100)));
      store.apply(env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA_SINGLE_TEXT, active: true }, (ts += 50)));
      store.apply(env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA_SINGLE_TEXT, active: false }, (ts += 50), 0, ACTOR_B));
      expect(
        (store.database.prepare("SELECT active FROM class_property WHERE class_id = ? AND property_schema_id = ?").get(CLASS_A, SCHEMA_SINGLE_TEXT) as { active: number }).active,
      ).toBe(0);
      // A stale re-enable is dropped by the row LWW.
      const stale = store.apply(
        env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA_SINGLE_TEXT, active: true }, ts - 25),
      );
      expect(stale.ignored).toBe(true);
      expect(
        (store.database.prepare("SELECT active FROM class_property WHERE class_id = ? AND property_schema_id = ?").get(CLASS_A, SCHEMA_SINGLE_TEXT) as { active: number }).active,
      ).toBe(0);
    });

    it("an inactive ANCESTOR binding stops supplying inherited defaults (extends-aware read)", () => {
      const store = seededStore();
      let ts = 1727200023000;
      store.apply(env("class.setExtends", { classId: CLASS_B, parentClassIds: [CLASS_A] }, (ts += 100)));
      store.apply(env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA_SINGLE_TEXT, defaultValue: "inherited" }, (ts += 100)));
      store.apply(env("object.create", { objectId: PAGE, classIds: [CLASS_B] }, (ts += 100)));
      expect(store.getEffectiveProperties(PAGE).filter((r) => r.propertySchemaId === SCHEMA_SINGLE_TEXT)).toEqual([
        expect.objectContaining({ source: "default", value: "inherited", boundBy: CLASS_A }),
      ]);
      store.apply(env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA_SINGLE_TEXT, active: false }, (ts += 100)));
      expect(store.getEffectiveProperties(PAGE).filter((r) => r.propertySchemaId === SCHEMA_SINGLE_TEXT)).toEqual([]);
    });

    it("an omitted active keeps the stored flag (patch semantics)", () => {
      const store = seededStore();
      let ts = 1727200024000;
      store.apply(env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA_SINGLE_TEXT, active: false }, (ts += 100)));
      store.apply(env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA_SINGLE_TEXT, sequence: 9 }, (ts += 100)));
      expect(
        store.database.prepare("SELECT active, sequence FROM class_property WHERE class_id = ? AND property_schema_id = ?").get(CLASS_A, SCHEMA_SINGLE_TEXT),
      ).toEqual({ active: 0, sequence: 9 });
    });

    it("concurrent active flips at the same HLC converge under EITHER delivery order", () => {
      const results: string[] = [];
      for (const order of ["enable-first", "disable-first"] as const) {
        const store = seededStore();
        let ts = 1727200024500;
        store.apply(env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA_SINGLE_TEXT, defaultValue: "fallback" }, (ts += 100)));
        const enable = env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA_SINGLE_TEXT, active: true }, 1727200025000, 0, ACTOR_A);
        const disable = env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA_SINGLE_TEXT, active: false }, 1727200025000, 0, ACTOR_B);
        store.applyMany(order === "enable-first" ? [enable, disable] : [disable, enable]);
        results.push(JSON.stringify(dumpDb(store)));
      }
      expect(results[1]).toEqual(results[0]);
      // The disable (bigger actor id) won the tie: no default derives.
      const store = seededStore();
      let ts = 1727200024500;
      store.apply(env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA_SINGLE_TEXT, defaultValue: "fallback" }, (ts += 100)));
      store.apply(env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA_SINGLE_TEXT, active: true }, 1727200025000, 0, ACTOR_A));
      store.apply(env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA_SINGLE_TEXT, active: false }, 1727200025000, 0, ACTOR_B));
      expect(store.getEffectiveProperties(PAGE).filter((r) => r.propertySchemaId === SCHEMA_SINGLE_TEXT)).toEqual([]);
    });
  });

  describe("§34.89 — binding display position + option icon", () => {
    const SCHEMA_SELECT = "0192a000-0000-7000-8000-0000000000a6";

    it("display persists on the binding row and rides the effective read (panel default)", () => {
      const store = seededStore();
      let ts = 1727200030000;
      store.apply(env("propertySchema.create", { propertySchemaId: SCHEMA_SELECT, name: "stage", type: "select", options: [{ id: "opt-a", label: "A", icon: "mdiCircle", color: "yellow" }] }, (ts += 100)));
      store.apply(env("object.create", { objectId: PAGE, classIds: [CLASS_A] }, (ts += 100)));
      // Absent display = the NULL 'panel' default.
      store.apply(env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA_SELECT, sequence: 1, defaultValue: "opt-a" }, (ts += 100)));
      expect(
        (store.database.prepare("SELECT display FROM class_property WHERE class_id = ? AND property_schema_id = ?").get(CLASS_A, SCHEMA_SELECT) as { display: string | null }).display,
      ).toBeNull();
      expect(store.getEffectiveProperties(PAGE).find((r) => r.propertySchemaId === SCHEMA_SELECT)?.display).toBeNull();
      // A display write lands on the row and surfaces on authored + default rows.
      store.apply(env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA_SELECT, display: "bullet" }, (ts += 100)));
      expect(
        (store.database.prepare("SELECT display FROM class_property WHERE class_id = ? AND property_schema_id = ?").get(CLASS_A, SCHEMA_SELECT) as { display: string | null }).display,
      ).toBe("bullet");
      expect(store.getEffectiveProperties(PAGE).find((r) => r.propertySchemaId === SCHEMA_SELECT)?.display).toBe("bullet");
      store.apply(env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_SELECT, value: "opt-a", idx: 0 }, (ts += 100)));
      expect(store.getEffectiveProperties(PAGE).find((r) => r.propertySchemaId === SCHEMA_SELECT && r.source === "authored")?.display).toBe("bullet");
      // Patch semantics: an omitted display keeps the stored position.
      store.apply(env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA_SELECT, sequence: 9 }, (ts += 100)));
      expect(
        (store.database.prepare("SELECT display, sequence FROM class_property WHERE class_id = ? AND property_schema_id = ?").get(CLASS_A, SCHEMA_SELECT) as { display: string | null; sequence: number }).display,
      ).toBe("bullet");
      // "inline" persists too; a stale write loses the row LWW.
      store.apply(env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA_SELECT, display: "inline" }, (ts += 100)));
      expect(store.getEffectiveProperties(PAGE).find((r) => r.propertySchemaId === SCHEMA_SELECT)?.display).toBe("inline");
      const stale = store.apply(env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA_SELECT, display: "bullet" }, ts - 50));
      expect(stale.ignored).toBe(true);
      expect(store.getEffectiveProperties(PAGE).find((r) => r.propertySchemaId === SCHEMA_SELECT)?.display).toBe("inline");
    });

    it("an unbound authored value reads display null; an inactive binding contributes nothing", () => {
      const store = seededStore();
      let ts = 1727200031000;
      store.apply(env("propertySchema.create", { propertySchemaId: SCHEMA_SELECT, name: "stage", type: "select" }, (ts += 100)));
      store.apply(env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_SELECT, value: "opt-x", idx: 0 }, (ts += 100)));
      expect(store.getEffectiveProperties(PAGE).find((r) => r.propertySchemaId === SCHEMA_SELECT)?.display).toBeNull();
      store.apply(env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA_SELECT, display: "bullet" }, (ts += 100)));
      store.apply(env("object.create", { objectId: PAGE, classIds: [CLASS_A] }, (ts += 100)));
      expect(store.getEffectiveProperties(PAGE).find((r) => r.propertySchemaId === SCHEMA_SELECT)?.display).toBe("bullet");
      store.apply(env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA_SELECT, active: false }, (ts += 100)));
      expect(store.getEffectiveProperties(PAGE).find((r) => r.propertySchemaId === SCHEMA_SELECT)?.display).toBeNull();
    });

    it("option icons ride the options JSON verbatim through create and wholesale update", () => {
      const store = seededStore();
      let ts = 1727200032000;
      store.apply(env("propertySchema.create", { propertySchemaId: SCHEMA_SELECT, name: "stage", type: "select", options: [{ id: "opt-a", label: "A", icon: "mdiCircle", color: "yellow" }] }, (ts += 100)));
      const stored = (): Array<Record<string, unknown>> =>
        JSON.parse((store.database.prepare("SELECT options FROM property_schema WHERE id = ?").get(SCHEMA_SELECT) as { options: string }).options) as Array<Record<string, unknown>>;
      expect(stored()[0]).toEqual({ id: "opt-a", label: "A", icon: "mdiCircle", color: "yellow" });
      // The settings-freeze contract: options replace wholesale, icons included.
      store.apply(env("propertySchema.update", { propertySchemaId: SCHEMA_SELECT, options: [{ id: "opt-a", label: "A" }, { id: "opt-b", label: "B", icon: "mdiCheckCircle" }] }, (ts += 100)));
      expect(stored()).toEqual([
        { id: "opt-a", label: "A" },
        { id: "opt-b", label: "B", icon: "mdiCheckCircle" },
      ]);
    });
  });

  describe("PC6 — date-node-backed qualifiers", () => {
    it("canonical refs ride the metadata verbatim; legacy ISO strings normalize on write", () => {
      const store = seededStore();
      let ts = 1727200025000;
      const startRef = { nodeId: dayNodeId("2020-03-04") };
      const endRef = { nodeId: dayNodeId("2022-05-06") };
      store.apply(env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_QUALIFIED, value: { nodeId: TARGET }, elementId: ELEM_A, idx: 0, metadata: { startDate: startRef, endDate: endRef, locator: "p. 1" } }, (ts += 100)));
      // Legacy strings on a dateQualified schema → deterministic day-node refs.
      store.apply(env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_QUALIFIED, value: { nodeId: TARGET }, elementId: ELEM_B, idx: 1, metadata: { startDate: "2019-01-15", endDate: "2021-12-31" } }, (ts += 100)));
      const rows = authoredValues(store, SCHEMA_QUALIFIED);
      expect(rows[0]?.elementId).toBe(ELEM_A);
      const metaA = store.getEffectiveProperties(PAGE).find((r) => r.elementId === ELEM_A)?.metadata;
      expect(metaA).toEqual({ startDate: startRef, endDate: endRef, locator: "p. 1" });
      const metaB = store.getEffectiveProperties(PAGE).find((r) => r.elementId === ELEM_B)?.metadata;
      expect(metaB).toEqual({
        startDate: { nodeId: dayNodeId("2019-01-15") },
        endDate: { nodeId: dayNodeId("2021-12-31") },
      });
    });

    it("normalization only fires for the reserved keys on dateQualified schemas", () => {
      const store = seededStore();
      let ts = 1727200026000;
      // A non-qualified schema: strings ride through untouched.
      store.apply(env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_PLAIN, value: { nodeId: TARGET }, idx: 0, metadata: { startDate: "2019-01-15" } }, (ts += 100)));
      expect(
        store.getEffectiveProperties(PAGE).find((r) => r.propertySchemaId === SCHEMA_PLAIN)?.metadata,
      ).toEqual({ startDate: "2019-01-15" });
      // A dateQualified schema: unrelated keys + malformed dates ride through.
      store.apply(env("propertySchema.create", { propertySchemaId: "0192a000-0000-7000-8000-0000000000a5", name: "q2", type: "object", dateQualified: true }, (ts += 100)));
      store.apply(env("property.set", { objectId: PAGE, propertySchemaId: "0192a000-0000-7000-8000-0000000000a5", value: { nodeId: TARGET }, idx: 0, metadata: { since: "1962", startDate: "not-a-date" } }, (ts += 100)));
      expect(
        store.getEffectiveProperties(PAGE).find((r) => r.propertySchemaId === "0192a000-0000-7000-8000-0000000000a5")?.metadata,
      ).toEqual({ since: "1962", startDate: "not-a-date" });
    });

    it("read-leniency: a legacy string row stored by another client reads back as authored", () => {
      const store = seededStore();
      let ts = 1727200027000;
      // Simulate a foreign client's stored row (string metadata, verbatim).
      const foreign = env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_QUALIFIED, value: { nodeId: TARGET }, idx: 0, metadata: { startDate: "2018-06-01" } }, (ts += 100));
      store.apply(foreign);
      // Rewrite the stored row the way a pre-PC6 replica would hold it.
      store.database
        .prepare("UPDATE property_value SET metadata = ? WHERE node_id = ? AND property_schema_id = ?")
        .run(JSON.stringify({ startDate: "2018-06-01" }), PAGE, SCHEMA_QUALIFIED);
      expect(
        store.getEffectiveProperties(PAGE).find((r) => r.propertySchemaId === SCHEMA_QUALIFIED)?.metadata,
      ).toEqual({ startDate: "2018-06-01" });
    });
  });
});

describe("fixture convergence (§34.56 batch)", () => {
  const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "protocol", "fixtures");
  function loadFixture(name: string): Record<string, unknown>[] {
    const raw = JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as {
      envelopes?: Record<string, unknown>[];
    };
    return Array.isArray(raw.envelopes) ? raw.envelopes : [raw as Record<string, unknown>];
  }

  function backendFor(name: string): StoreBackend {
    if (name === "sqljs") return sqljsBackend(sqlModule);
    const dir = mkdtempSync(join(tmpdir(), "notees-fixconv-test-"));
    tmpDirs.push(dir);
    return betterSqlite3Backend(join(dir, "store.db"));
  }

  // The fixtures are CAUSAL chains (each op builds on the last) — the relay
  // delivers the single global log in seq order to every replica, so forward
  // replay is the one legal order; the both-orders dimension belongs to
  // genuinely CONCURRENT ops (pinned separately in the PG5/PC4 suites above
  // with same-HLC pairs applied in both orders).
  const FORWARD_ONLY = [
    "property-value-elements.json",
    "class-property-active.json",
    "property-date-qualifier.json",
  ];

  it.each(FORWARD_ONLY)("%s converges byte-identical on both adapters (causal forward replay)", (name) => {
    const fixture = loadFixture(name);
    const dumps: Record<string, unknown>[] = [];
    for (const backend of ["sqljs", "better-sqlite3"]) {
      const store = Store.open(backendFor(backend));
      store.applyMany(fixture);
      dumps.push(dumpDb(store));
      // Re-application is a pure idempotency no-op.
      const again = store.applyMany(fixture);
      expect(again.every((s) => s.ignored)).toBe(true);
      store.close();
    }
    expect(dumps[1]).toEqual(dumps[0]);
  });

  it("the whole corpus replays into both adapters with the batch fixtures included", () => {
    const all = readdirSync(fixturesDir)
      .filter((f) => f.endsWith(".json") && f !== "class-extends-cycle.json")
      .sort()
      .flatMap(loadFixture);
    const dumps: Record<string, unknown>[] = [];
    for (const backend of ["sqljs", "better-sqlite3"]) {
      const store = Store.open(backendFor(backend));
      store.applyMany(all);
      dumps.push(dumpDb(store));
      store.close();
    }
    expect(dumps[1]).toEqual(dumps[0]);
  });
});
