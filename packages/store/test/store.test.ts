/**
 * Derived-state store tests: schema invariants (bullet-proof CHECKs),
 * canonical fixture replay from @notees/protocol, LWW/OR-Set convergence,
 * op-log idempotency, wipe -> replay determinism, and FTS prefix-AND search.
 *
 * Every suite runs against BOTH shipped adapters — sql.js (in-memory WASM,
 * the browser target) and better-sqlite3 (file-backed temp dir) — so the
 * driver-agnostic surface in src/db.ts cannot silently drift toward one
 * driver. Semantics are identical; the only backend difference is the FTS
 * module (stock sql.js has no FTS5, so it builds the same search index with
 * FTS4 — same MATCH/prefix syntax).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import initSqlJs, { type SqlJsStatic } from "sql.js";

import type { StoreBackend } from "../src/db.js";

import { newEnvelope, type ContentAst, type Envelope } from "@notees/protocol";

import {
  CheckConstraintError,
  CycleError,
  MoveGuardError,
  NotFoundError,
  Store,
  UnsupportedCarrierError,
  type StoreBackend,
} from "../src/index.js";
import { betterSqlite3Backend } from "../src/adapters/better-sqlite3.js";
import { sqljsBackend } from "../src/adapters/sqljs.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "protocol", "fixtures");

/** Fixture envelopes, in a fixed order (alphabetical by file name). */
const FIXTURE_FILES = readdirSync(fixturesDir).filter((f) => f.endsWith(".json")).sort();

function loadFixture(name: string): Record<string, unknown>[] {
  const raw = JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as {
    envelopes?: Record<string, unknown>[];
  };
  return Array.isArray(raw.envelopes) ? raw.envelopes : [raw as Record<string, unknown>];
}

/** Fixtures whose application must THROW — never part of the all-fixtures
 * replay/determinism sets (class-extends-cycle.json closes cycles and fails
 * loud by design; it is applied deliberately in its own test). */
const REPLAY_EXCLUDED_FIXTURES = new Set(["class-extends-cycle.json"]);

function allFixtureEnvelopes(): Record<string, unknown>[] {
  return FIXTURE_FILES.filter((f) => !REPLAY_EXCLUDED_FIXTURES.has(f)).flatMap(loadFixture);
}

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const NODE_PAGE = "0192a000-0000-7000-8000-000000000010";
const NODE_BOOK = "0192a000-0000-7000-8000-000000000011";
const NODE_BLOCK = "0192a000-0000-7000-8000-000000000020";
const PROP_SCHEMA = "0192a000-0000-7000-8000-0000000000a1";
const BOOK_CLASS = "00000000-0000-0000-0001-000000000025";

/** Envelope factory for hand-built ops (deterministic timestamps). */
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
    deviceId: "test-device-store",
    hlc: { physical, logical },
    opType,
    payload,
    timestamp: new Date(physical).toISOString(),
  });
}

function createPage(id: string, physical: number): Envelope {
  return env("object.create", { objectId: id, nodeType: "page" }, physical);
}

/**
 * Full-database dump, deterministic ordering, for convergence checks.
 * Excludes sync_state (restore_epoch is environmental) and, by default,
 * applied_envelope (the local application log — its seq is the local apply
 * order, so cross-order comparisons legitimately differ; same-order replay
 * comparisons can opt back in with `withAppliedLog`). FTS shadow tables of
 * both FTS4 and FTS5 are excluded (the sql.js backend builds FTS4).
 */
function dumpDb(store: Store, options: { withAppliedLog?: boolean } = {}): Record<string, unknown[]> {
  const tables = (
    store.database
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         AND name NOT IN (
           'search_index_data', 'search_index_idx', 'search_index_config',
           'search_index_docsize', 'search_index_content',
           'search_index_segments', 'search_index_segdir', 'search_index_stat'
         )
         AND name != 'sync_state' -- restore_epoch is environmental, not derived state
         ${options.withAppliedLog ? "" : "AND name != 'applied_envelope'"}
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

// --- adapters under test -------------------------------------------------------

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

/** Temp dirs of file-backed better-sqlite3 stores, cleaned after each test. */
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const adapters: { name: string; makeBackend: () => StoreBackend }[] = [
  {
    name: "sqljs",
    makeBackend: () => sqljsBackend(sqlModule),
  },
  {
    name: "better-sqlite3",
    makeBackend: () => {
      const dir = mkdtempSync(join(tmpdir(), "notees-store-test-"));
      tmpDirs.push(dir);
      return betterSqlite3Backend(join(dir, "store.db"));
    },
  },
];

// --- suites (run against every adapter) ------------------------------------------

describe.each(adapters)("$name", ({ makeBackend }) => {
  function makeStore(): Store {
    return Store.open(makeBackend());
  }

  function baseStore(): Store {
    const store = makeStore();
    store.applyMany([createPage(NODE_PAGE, 1727200000000), createPage(NODE_BOOK, 1727200001000)]);
    return store;
  }

  function baseStoreWithBlock(): Store {
    const store = baseStore();
    store.apply(
      env("object.create", { objectId: NODE_BLOCK, nodeType: "block", parentId: NODE_PAGE }, 1727200000500),
    );
    return store;
  }

  describe("schema invariants (bullet-proof CHECKs)", () => {
    it("rejects a parentless block row", () => {
      const store = makeStore();
      expect(() =>
        store.database
          .prepare("INSERT INTO node (id, workspace_id, node_type, parent_id) VALUES ('a', 'ws', 'block', NULL)")
          .run(),
      ).toThrow(/CHECK constraint failed/);
    });

    it("rejects a class row with a parent", () => {
      const store = makeStore();
      store.database
        .prepare("INSERT INTO node (id, workspace_id, node_type, parent_id) VALUES ('p', 'ws', 'page', NULL)")
        .run();
      expect(() =>
        store.database
          .prepare("INSERT INTO node (id, workspace_id, node_type, parent_id) VALUES ('c', 'ws', 'class', 'p')")
          .run(),
      ).toThrow(/CHECK constraint failed/);
    });

    it("accepts a parentless page", () => {
      const store = makeStore();
      expect(() =>
        store.database
          .prepare("INSERT INTO node (id, workspace_id, node_type, parent_id) VALUES ('p2', 'ws', 'page', NULL)")
          .run(),
      ).not.toThrow();
    });

    it("surfaces CHECK violations from the applier as typed errors", () => {
      const store = baseStore();
      // Declare a class while giving it a parent: payload nodeType wins, and
      // the CHECK (class => parentless) must fail loud, not silently clamp.
      const fresh = "0192a000-0000-7000-8000-0000000000c9";
      expect(() =>
        store.apply(
          env("object.create", { objectId: fresh, nodeType: "class", parentId: NODE_PAGE }, 1727200001000),
        ),
      ).toThrow(CheckConstraintError);
    });

    it("rejects demoting a parentless page to a block", () => {
      const store = baseStore();
      expect(() =>
        store.apply(env("object.update", { objectId: NODE_PAGE, nodeType: "block" }, 1727200002000)),
      ).toThrow(CheckConstraintError);
    });

    it("rejects a class parent (cross-row move guard, fail loud)", () => {
      const store = baseStore();
      store.apply(env("class.create", { classId: "c0000000-0000-7000-8000-0000000000c1", contentAst: [{ type: "text", text: "Tag" }]}, 1727200001500));
      expect(() =>
        store.apply(
          env(
            "object.create",
            { objectId: "b0000000-0000-7000-8000-0000000000b1", parentId: "c0000000-0000-7000-8000-0000000000c1" },
            1727200002000,
          ),
        ),
      ).toThrow(MoveGuardError);
    });
  });

  describe("fixture replay (canonical protocol fixtures)", () => {
    it("lands object.create fixtures as pages", () => {
      const store = makeStore();
      store.applyMany(allFixtureEnvelopes());
      const page = store.getNode(NODE_PAGE);
      const book = store.getNode(NODE_BOOK);
      expect(page?.node_type).toBe("page");
      expect(book?.node_type).toBe("page");
      expect(
        JSON.parse(book?.content ?? "[]").find((t: { type?: string }) => t.type === "text")?.text,
      ).toBe("The Structure of Scientific Revolutions");
      // classIds seed the OR-Set membership, projected into node.class_ids.
      expect(JSON.parse(book?.class_ids ?? "[]")).toEqual([BOOK_CLASS]);
    });

    it("converges the property LWW fixture to the higher-HLC phone value", () => {
      const store = makeStore();
      store.applyMany(allFixtureEnvelopes());
      const row = store.database
        .prepare(
          "SELECT value, metadata, actor_id FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = 0",
        )
        .get(NODE_BOOK, PROP_SCHEMA) as { value: string; metadata: string; actor_id: string };
      expect(JSON.parse(row.value)).toEqual({
        nodeId: "0192a000-0000-7000-8000-000000000031",
      });
      expect(JSON.parse(row.metadata)).toEqual({ since: "1963" });
      expect(row.actor_id).toBe("0192a000-0000-7000-8000-000000000003");
    });

    it("derives a typed_link edge with locator + candidateSpans from the mark fixture", () => {
      const store = baseStoreWithBlock();
      store.applyMany(loadFixture("typed-link-mark.json"));
      const edge = store.database
        .prepare("SELECT * FROM edge WHERE source_id = ? AND type = 'typed_link'")
        .get(NODE_BLOCK) as Record<string, unknown>;
      expect(edge).toBeDefined();
      expect(edge.verb).toBe("cites");
      const metadata = JSON.parse(edge.metadata as string);
      expect(metadata.locator).toBe("p. 42");
      expect(metadata.candidateSpans).toEqual(["tok_3", "tok_7"]);
      // The mention token in the same content derives a mention edge.
      const mention = store.database
        .prepare("SELECT * FROM edge WHERE source_id = ? AND type = 'mention'")
        .get(NODE_BLOCK) as { target_id: string } | undefined;
      expect(mention?.target_id).toBe(NODE_BOOK);
    });

    it("drops the typed_link edge when the marked word is deleted", () => {
      const store = baseStoreWithBlock();
      store.applyMany(loadFixture("typed-link-mark.json"));
      store.applyMany(loadFixture("typed-link-mark-deleted.json"));
      const typedLinks = store.database
        .prepare("SELECT COUNT(*) AS n FROM edge WHERE source_id = ? AND type = 'typed_link'")
        .get(NODE_BLOCK) as { n: number };
      expect(typedLinks.n).toBe(0);
      const mentions = store.database
        .prepare("SELECT COUNT(*) AS n FROM edge WHERE source_id = ? AND type = 'mention'")
        .get(NODE_BLOCK) as { n: number };
      expect(mentions.n).toBe(0);
      const content = JSON.parse(store.getNode(NODE_BLOCK)?.content ?? "[]") as ContentAst;
      expect(content).toEqual([{ type: "text", text: "Kuhn cites earlier work." }]);
    });
  });

  describe("convergence", () => {
    it("property-set-lww converges regardless of application order", () => {
      const [laptop, phone] = loadFixture("property-set-lww.json");
      const forward = baseStore();
      forward.applyMany([laptop, phone]);
      const backward = baseStore();
      backward.applyMany([phone, laptop]);
      const winnerOf = (store: Store) => {
        const row = store.database
          .prepare(
            "SELECT value, metadata FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = 0",
          )
          .get(NODE_BOOK, PROP_SCHEMA) as { value: string; metadata: string };
        return { value: JSON.parse(row.value), metadata: JSON.parse(row.metadata) };
      };
      const expected = {
        value: { nodeId: "0192a000-0000-7000-8000-000000000031" },
        metadata: { since: "1963" },
      };
      expect(winnerOf(forward)).toEqual(expected);
      expect(winnerOf(backward)).toEqual(expected);
    });

    it("content updates converge regardless of envelope order (row LWW)", () => {
      const mark = loadFixture("typed-link-mark.json")[0]!;
      const deleted = loadFixture("typed-link-mark-deleted.json")[0]!;
      const base = [
        createPage(NODE_PAGE, 1727200000000),
        createPage(NODE_BOOK, 1727200001000),
        env("object.create", { objectId: NODE_BLOCK, nodeType: "block", parentId: NODE_PAGE }, 1727200000500),
      ];
      const storeA = makeStore();
      storeA.applyMany([...base, mark, deleted]);
      const storeB = makeStore();
      storeB.applyMany([...base, deleted, mark]);
      expect(dumpDb(storeA)).toEqual(dumpDb(storeB));
      const typedLinks = storeB.database
        .prepare("SELECT COUNT(*) AS n FROM edge WHERE type = 'typed_link'")
        .get() as { n: number };
      expect(typedLinks.n).toBe(0);
    });

    it("a lower-HLC object.update is dropped by LWW", () => {
      const store = baseStore();
      const result = store.apply(
        env("object.update", { objectId: NODE_BOOK, contentAst: [{ type: "text", text: "stale name" }]}, 1727200000900, 0),
      );
      expect(result.ignored).toBe(true);
      expect(store.getNode(NODE_BOOK)?.name).toBeNull();
    });

    it("property.unset tombstone wins over a later-arriving lower-HLC set", () => {
      const store = baseStore();
      store.applyMany(loadFixture("property-set-lww.json"));
      store.apply(env("property.unset", { objectId: NODE_BOOK, propertySchemaId: PROP_SCHEMA }, 1727200006000));
      expect(
        (
          store.database
            .prepare("SELECT COUNT(*) AS n FROM property_value WHERE node_id = ?")
            .get(NODE_BOOK) as { n: number }
        ).n,
      ).toBe(0);
      // A set with a lower HLC than the tombstone must not resurrect the value.
      const res = store.apply(
        env(
          "property.set",
          { objectId: NODE_BOOK, propertySchemaId: PROP_SCHEMA, value: { nodeId: NODE_PAGE } },
          1727200005900,
        ),
      );
      expect(res.ignored).toBe(true);
      expect(
        (
          store.database
            .prepare("SELECT COUNT(*) AS n FROM property_value WHERE node_id = ?")
            .get(NODE_BOOK) as { n: number }
        ).n,
      ).toBe(0);
    });

    it("collection membership is an add-wins OR-Set", () => {
      const store = baseStore();
      const collection = "0192a000-0000-7000-8000-0000000000c0";
      // Equal HLC + actor: the add wins over the remove.
      store.apply(env("collection.member.add", { collectionId: collection, objectId: NODE_BOOK }, 1727200010000));
      store.apply(env("collection.member.remove", { collectionId: collection, objectId: NODE_BOOK }, 1727200010000));
      let row = store.database
        .prepare("SELECT present FROM collection_member WHERE collection_id = ? AND object_id = ?")
        .get(collection, NODE_BOOK) as { present: number };
      expect(row.present).toBe(1);
      // A strictly higher-HLC remove clears membership.
      store.apply(env("collection.member.remove", { collectionId: collection, objectId: NODE_BOOK }, 1727200010001));
      row = store.database
        .prepare("SELECT present FROM collection_member WHERE collection_id = ? AND object_id = ?")
        .get(collection, NODE_BOOK) as { present: number };
      expect(row.present).toBe(0);
    });

    it("class.setExtends maintains the transitive closure and fails loud on cycles", () => {
      const store = baseStore();
      const a = "0192a000-0000-7000-8000-0000000000a1";
      const b = "0192a000-0000-7000-8000-0000000000b1";
      const c = "0192a000-0000-7000-8000-0000000000c2";
      store.apply(env("class.create", { classId: a, contentAst: [{ type: "text", text: "Source" }]}, 1727200001000));
      store.apply(env("class.create", { classId: b, contentAst: [{ type: "text", text: "Work" }]}, 1727200001100));
      store.apply(env("class.create", { classId: c, contentAst: [{ type: "text", text: "Annotation" }]}, 1727200001200));
      store.apply(env("class.setExtends", { classId: b, parentClassIds: [a] }, 1727200001300));
      store.apply(env("class.setExtends", { classId: c, parentClassIds: [b] }, 1727200001400));
      const closure = store.database
        .prepare("SELECT class_id, ancestor_id FROM class_hierarchy ORDER BY class_id, ancestor_id")
        .all();
      expect(closure).toEqual([
        { class_id: a, ancestor_id: a },
        { class_id: b, ancestor_id: a },
        { class_id: b, ancestor_id: b },
        { class_id: c, ancestor_id: a },
        { class_id: c, ancestor_id: b },
        { class_id: c, ancestor_id: c },
      ]);
      expect(() =>
        store.apply(env("class.setExtends", { classId: a, parentClassIds: [c] }, 1727200001500)),
      ).toThrow(CycleError);
      expect(() =>
        store.apply(env("class.setExtends", { classId: a, parentClassIds: [a] }, 1727200001500)),
      ).toThrow(CycleError);
    });

    it("class-extends-m2m fixture: multiple parents land the child under BOTH ancestors", () => {
      const store = makeStore();
      store.applyMany(loadFixture("class-extends-m2m.json"));
      const a = "0192a000-0000-7000-8000-0000000000c5";
      const b = "0192a000-0000-7000-8000-0000000000c6";
      const c = "0192a000-0000-7000-8000-0000000000c7";
      // Direct edge set is exactly the payload array.
      const edges = store.database
        .prepare(
          "SELECT parent_class_id FROM class_extends WHERE class_id = ? ORDER BY parent_class_id",
        )
        .all(c) as { parent_class_id: string }[];
      expect(edges.map((e) => e.parent_class_id)).toEqual([a, b].sort());
      // C ∈ descendants-of-A AND descendants-of-B (diamond closure rows).
      const ancestorsOfC = store.database
        .prepare(
          "SELECT ancestor_id FROM class_hierarchy WHERE class_id = ? ORDER BY ancestor_id",
        )
        .all(c) as { ancestor_id: string }[];
      expect(ancestorsOfC.map((r) => r.ancestor_id)).toEqual([a, b, c].sort());
      for (const parent of [a, b]) {
        const descendants = store.database
          .prepare(
            "SELECT class_id FROM class_hierarchy WHERE ancestor_id = ? ORDER BY class_id",
          )
          .all(parent) as { class_id: string }[];
        expect(descendants.map((r) => r.class_id)).toContain(c);
      }
    });

    it("class-extends-cycle fixture throws the cycle error on apply", () => {
      const [root, leaf, leafExtendsRoot, rootExtendsLeaf, rootExtendsRootSelf] = loadFixture(
        "class-extends-cycle.json",
      );
      const rootId = "0192a000-0000-7000-8000-0000000000d1";
      const leafId = "0192a000-0000-7000-8000-0000000000d2";
      const store = makeStore();
      // The prefix applies cleanly.
      store.applyMany([root!, leaf!, leafExtendsRoot!]);
      expect(
        store.database
          .prepare(
            "SELECT ancestor_id FROM class_hierarchy WHERE class_id = ? ORDER BY ancestor_id",
          )
          .all(leafId),
      ).toEqual([{ ancestor_id: rootId }, { ancestor_id: leafId }]);

      // Multi-hop cycle: Root extends [Leaf] with Leaf already under Root.
      expect(() => store.apply(rootExtendsLeaf!)).toThrow(CycleError);
      // Self-parent: Root extends [Root].
      expect(() => store.apply(rootExtendsRootSelf!)).toThrow(CycleError);

      // A thrown apply rolls back: the closure is exactly the prefix state.
      expect(
        store.database
          .prepare(
            "SELECT ancestor_id FROM class_hierarchy WHERE class_id = ? ORDER BY ancestor_id",
          )
          .all(rootId),
      ).toEqual([{ ancestor_id: rootId }]);
      expect(
        (store.database.prepare("SELECT COUNT(*) AS n FROM class_extends").get() as { n: number }).n,
      ).toBe(1);
    });

    it("class.setExtends replace semantics: a second array removes stale closure rows", () => {
      const store = makeStore();
      store.applyMany(loadFixture("class-extends-m2m.json"));
      const a = "0192a000-0000-7000-8000-0000000000c5";
      const b = "0192a000-0000-7000-8000-0000000000c6";
      const c = "0192a000-0000-7000-8000-0000000000c7";
      const ancestorsOfC = () =>
        (
          store.database
            .prepare(
              "SELECT ancestor_id FROM class_hierarchy WHERE class_id = ? ORDER BY ancestor_id",
            )
            .all(c) as { ancestor_id: string }[]
        ).map((r) => r.ancestor_id);

      // Replace [A, B] with [B]: A is no longer reachable from C.
      store.apply(env("class.setExtends", { classId: c, parentClassIds: [b] }, 1727200007000));
      expect(ancestorsOfC()).toEqual([b, c]);
      expect(
        store.database
          .prepare(
            "SELECT class_id FROM class_hierarchy WHERE ancestor_id = ? AND class_id = ?",
          )
          .get(a, c),
      ).toBeUndefined();

      // Replace with []: detach all parents; only the self-row remains.
      store.apply(env("class.setExtends", { classId: c, parentClassIds: [] }, 1727200007100));
      expect(ancestorsOfC()).toEqual([c]);
      expect(
        (store.database.prepare("SELECT COUNT(*) AS n FROM class_extends").get() as { n: number }).n,
      ).toBe(0);
    });

    it("re-applying the whole fixture set is idempotent (applied_envelope)", () => {
      const store = makeStore();
      store.applyMany(allFixtureEnvelopes());
      const before = dumpDb(store);
      const second = store.applyMany(allFixtureEnvelopes());
      expect(second.every((s) => s.ignored)).toBe(true);
      expect(dumpDb(store)).toEqual(before);
      expect(
        (store.database.prepare("SELECT COUNT(*) AS n FROM applied_envelope").get() as { n: number }).n,
      ).toBe(allFixtureEnvelopes().length);
    });
  });

  describe("class properties (bindings, defaults, aggregation)", () => {
    const PRIORITY = "0192a000-0000-7000-8000-000000000301";
    const TASK = "0192a000-0000-7000-8000-000000000302";
    const PROJECT = "0192a000-0000-7000-8000-000000000303";
    const ITEM = "0192a000-0000-7000-8000-000000000304";

    const EFFORT = "0192a000-0000-7000-8000-0000000003a1";
    const IMPACT = "0192a000-0000-7000-8000-0000000003a2";
    const CLASS_X = "0192a000-0000-7000-8000-0000000003b1";
    const CLASS_Y = "0192a000-0000-7000-8000-0000000003b2";

    function makeSchema(store: Store, id: string, name: string, physical: number): void {
      store.apply(
        env("propertySchema.create", { propertySchemaId: id, name, type: "text" }, physical),
      );
    }

    function makeClass(store: Store, id: string, name: string, physical: number): void {
      store.apply(env("class.create", { classId: id, contentAst: [{ type: "text", text: name }] }, physical));
    }

    function bind(
      store: Store,
      classId: string,
      schemaId: string,
      defaultValue: string,
      physical: number,
    ): void {
      store.apply(
        env(
          "class.property.set",
          { classId, propertySchemaId: schemaId, sequence: 0, defaultValue },
          physical,
        ),
      );
    }

    it("class.property.set upserts the binding row; a patch keeps omitted fields and a stale set is dropped", () => {
      const store = makeStore();
      store.applyMany(loadFixture("class-property-defaults.json").slice(0, 5));
      const row = () =>
        store.database
          .prepare("SELECT * FROM class_property WHERE class_id = ? AND property_schema_id = ?")
          .get(TASK, PRIORITY) as Record<string, unknown>;
      expect(row()).toMatchObject({ sequence: 0, default_value: '"medium"' });

      // Patch only the default + required: sequence survives the update.
      store.apply(
        env(
          "class.property.set",
          { classId: TASK, propertySchemaId: PRIORITY, defaultValue: "low", required: true },
          1727200012000,
        ),
      );
      expect(row()).toMatchObject({
        sequence: 0,
        required: 1,
        default_value: '"low"',
        hlc_physical: 1727200012000,
      });

      // A lower-HLC set is dropped by row LWW (state unchanged).
      const stale = store.apply(
        env(
          "class.property.set",
          { classId: TASK, propertySchemaId: PRIORITY, defaultValue: "stale" },
          1727200010500,
        ),
      );
      expect(stale.ignored).toBe(true);
      expect(row()).toMatchObject({ default_value: '"low"', hlc_physical: 1727200012000 });
    });

    it("class.property.unset deletes the binding row", () => {
      const store = makeStore();
      store.applyMany(loadFixture("class-property-defaults.json").slice(0, 6));
      expect(
        store.database
          .prepare("SELECT 1 FROM class_property WHERE class_id = ? AND property_schema_id = ?")
          .get(PROJECT, PRIORITY),
      ).toBeDefined();
      store.apply(env("class.property.unset", { classId: PROJECT, propertySchemaId: PRIORITY }, 1727200013000));
      expect(
        store.database
          .prepare("SELECT 1 FROM class_property WHERE class_id = ? AND property_schema_id = ?")
          .get(PROJECT, PRIORITY),
      ).toBeUndefined();
    });

    it("fixture: default applies; multi-class conflict resolves first-applied-wins; unset flips the winner", () => {
      const store = makeStore();
      const fixture = loadFixture("class-property-defaults.json");
      const priorityOf = () => store.getEffectiveProperties(ITEM);

      store.applyMany(fixture.slice(0, 5)); // schema, classes, node (Task), Task binding
      expect(priorityOf()).toEqual([
        {
          propertySchemaId: PRIORITY,
          idx: 0,
          schema: {
            id: PRIORITY,
            name: "priority",
            type: "select",
            multi: false,
            datePrecision: null,
            dateQualified: null,
          },
          value: "medium",
          metadata: null,
          source: "default",
          boundBy: TASK,
          required: null,
          readonly: null,
          hideWhenEmpty: null,
          sequence: 0,
        },
      ]);
      // The default is DERIVED: no property_value row was ever written.
      expect(
        (
          store.database
            .prepare("SELECT COUNT(*) AS n FROM property_value WHERE node_id = ?")
            .get(ITEM) as { n: number }
        ).n,
      ).toBe(0);

      store.applyMany(fixture.slice(5, 7)); // Project binding + Project assignment
      // Task's membership add HLC (fixture envelope 4) precedes Project's
      // (envelope 7): Task's 'medium' wins the default conflict over 'high'.
      expect(priorityOf()).toEqual([
        expect.objectContaining({ value: "medium", source: "default", boundBy: TASK }),
      ]);
      expect(
        JSON.parse(store.getNode(ITEM)?.class_ids ?? "[]").sort(),
      ).toEqual([TASK, PROJECT].sort());

      store.apply(fixture[7]!); // unset Task's binding
      expect(priorityOf()).toEqual([
        expect.objectContaining({ value: "high", source: "default", boundBy: PROJECT }),
      ]);
    });

    it("aggregates the union of bindings across ALL of the node's classes", () => {
      const store = makeStore();
      makeSchema(store, EFFORT, "effort", 1727200011000);
      makeSchema(store, IMPACT, "impact", 1727200011100);
      makeClass(store, CLASS_X, "X", 1727200011200);
      makeClass(store, CLASS_Y, "Y", 1727200011300);
      bind(store, CLASS_X, EFFORT, "xs", 1727200011400);
      bind(store, CLASS_Y, IMPACT, "xl", 1727200011500);
      const node = "0192a000-0000-7000-8000-0000000003c1";
      store.apply(
        env("object.create", { objectId: node, nodeType: "page", classIds: [CLASS_X, CLASS_Y] }, 1727200011600),
      );

      const effective = store.getEffectiveProperties(node);
      expect(effective.map((row) => [row.schema?.name, row.value, row.boundBy])).toEqual([
        ["effort", "xs", CLASS_X],
        ["impact", "xl", CLASS_Y],
      ]);
    });

    it("conflict resolution follows assignment HLC (earliest first), not class id or write order", () => {
      const store = makeStore();
      makeSchema(store, EFFORT, "effort", 1727200011000);
      makeClass(store, CLASS_X, "X", 1727200011100);
      makeClass(store, CLASS_Y, "Y", 1727200011200);
      // Write order is the reverse of assignment order, and the binding
      // defaults are written in between.
      bind(store, CLASS_Y, EFFORT, "y", 1727200012500);
      bind(store, CLASS_X, EFFORT, "x", 1727200012600);

      // Node 1: X assigned first, Y later.
      const node1 = "0192a000-0000-7000-8000-0000000003c1";
      store.apply(env("object.create", { objectId: node1, nodeType: "page", classIds: [CLASS_X] }, 1727200011300));
      store.apply(env("object.create", { objectId: node1, nodeType: "page", classIds: [CLASS_Y] }, 1727200012000));

      // Node 2: Y assigned first, X later.
      const node2 = "0192a000-0000-7000-8000-0000000003c2";
      store.apply(env("object.create", { objectId: node2, nodeType: "page", classIds: [CLASS_Y] }, 1727200011400));
      store.apply(env("object.create", { objectId: node2, nodeType: "page", classIds: [CLASS_X] }, 1727200012100));

      expect(store.getEffectiveProperties(node1)).toEqual([
        expect.objectContaining({ value: "x", boundBy: CLASS_X }),
      ]);
      expect(store.getEffectiveProperties(node2)).toEqual([
        expect.objectContaining({ value: "y", boundBy: CLASS_Y }),
      ]);
    });

    it("an exact assignment-HLC tie breaks by class id", () => {
      const store = makeStore();
      makeSchema(store, EFFORT, "effort", 1727200011000);
      makeClass(store, CLASS_X, "X", 1727200011100);
      makeClass(store, CLASS_Y, "Y", 1727200011200);
      bind(store, CLASS_Y, EFFORT, "y", 1727200011300);
      bind(store, CLASS_X, EFFORT, "x", 1727200011400);
      // Both classes seeded by ONE object.create: identical membership HLCs.
      const node = "0192a000-0000-7000-8000-0000000003c1";
      store.apply(env("object.create", { objectId: node, nodeType: "page", classIds: [CLASS_Y, CLASS_X] }, 1727200011500));

      expect(store.getEffectiveProperties(node)).toEqual([
        expect.objectContaining({ value: "x", boundBy: CLASS_X }),
      ]);
    });

    it("class removal drops the derived default; an authored value survives unbound", () => {
      const store = makeStore();
      makeSchema(store, EFFORT, "effort", 1727200011000);
      makeClass(store, CLASS_X, "X", 1727200011100);
      bind(store, CLASS_X, EFFORT, "xs", 1727200011200);

      const authoredNode = "0192a000-0000-7000-8000-0000000003c1";
      store.apply(env("object.create", { objectId: authoredNode, nodeType: "page", classIds: [CLASS_X] }, 1727200011300));
      store.apply(env("property.set", { objectId: authoredNode, propertySchemaId: EFFORT, value: "authored" }, 1727200011400));
      const derivedNode = "0192a000-0000-7000-8000-0000000003c2";
      store.apply(env("object.create", { objectId: derivedNode, nodeType: "page", classIds: [CLASS_X] }, 1727200011300));

      // The unassign op tombstones the OR-Set membership pair.
      for (const node of [authoredNode, derivedNode]) {
        store.apply(env("class.unassign", { objectId: node, classId: CLASS_X }, 1727200011500));
        expect(JSON.parse(store.getNode(node)?.class_ids ?? "[]")).toEqual([]);
      }

      // Derived default: gone — nothing stored, nothing to clean.
      expect(store.getEffectiveProperties(derivedNode)).toEqual([]);
      // Authored value: survives, marked unbound (boundBy null).
      expect(store.getEffectiveProperties(authoredNode)).toEqual([
        expect.objectContaining({
          value: "authored",
          source: "authored",
          boundBy: null,
          required: null,
          sequence: null,
        }),
      ]);
    });

    it("class.unassign fixture: unassign drops the derived default, the authored value survives unbound, re-assign restores", () => {
      const store = makeStore();
      const fixture = loadFixture("class-unassign.json");
      const EFFORT = "0192a000-0000-7000-8000-000000000410";
      const IMPACT = "0192a000-0000-7000-8000-000000000411";
      const TASK = "0192a000-0000-7000-8000-000000000412";
      const ITEM = "0192a000-0000-7000-8000-000000000413";

      // Schemas, class, classed node, both bindings, authored impact value.
      store.applyMany(fixture.slice(0, 7));
      expect(store.getEffectiveProperties(ITEM)).toEqual([
        expect.objectContaining({ propertySchemaId: EFFORT, value: "xs", source: "default", boundBy: TASK }),
        expect.objectContaining({ propertySchemaId: IMPACT, value: "authored", source: "authored", boundBy: TASK }),
      ]);

      // The unassign: class_ids recomputed empty; the derived 'effort' default
      // stops reading (nothing stored, nothing to clean); the authored impact
      // value survives, marked unbound.
      store.apply(fixture[7]!);
      expect(JSON.parse(store.getNode(ITEM)?.class_ids ?? "[]")).toEqual([]);
      expect(store.getEffectiveProperties(ITEM)).toEqual([
        expect.objectContaining({ propertySchemaId: IMPACT, value: "authored", source: "authored", boundBy: null }),
      ]);

      // Re-assign via the re-issued object.create (OR-Set add-wins, newer HLC):
      // the default is derived again and the authored value reads bound by Task.
      store.apply(fixture[8]!);
      expect(JSON.parse(store.getNode(ITEM)?.class_ids ?? "[]")).toEqual([TASK]);
      expect(store.getEffectiveProperties(ITEM)).toEqual([
        expect.objectContaining({ propertySchemaId: EFFORT, value: "xs", source: "default", boundBy: TASK }),
        expect.objectContaining({ propertySchemaId: IMPACT, value: "authored", source: "authored", boundBy: TASK }),
      ]);
    });

    it("class.unassign is an add-wins OR-Set remove: a stale remove loses to a newer add", () => {
      const store = makeStore();
      makeSchema(store, EFFORT, "effort", 1727200011000);
      makeClass(store, CLASS_X, "X", 1727200011100);
      bind(store, CLASS_X, EFFORT, "xs", 1727200011200);
      const node = "0192a000-0000-7000-8000-0000000003c1";
      store.apply(env("object.create", { objectId: node, nodeType: "page", classIds: [CLASS_X] }, 1727200011300));
      const row = () =>
        store.database
          .prepare("SELECT present, hlc_physical FROM class_member_set WHERE node_id = ? AND class_id = ?")
          .get(node, CLASS_X) as { present: number; hlc_physical: number };

      // A strictly higher-HLC remove clears membership and drops the default.
      store.apply(env("class.unassign", { objectId: node, classId: CLASS_X }, 1727200011400));
      expect(row()).toEqual({ present: 0, hlc_physical: 1727200011400 });
      expect(JSON.parse(store.getNode(node)?.class_ids ?? "[]")).toEqual([]);
      expect(store.getEffectiveProperties(node)).toEqual([]);

      // Re-add with a newer HLC restores membership and the derived default.
      store.apply(env("object.create", { objectId: node, classIds: [CLASS_X] }, 1727200011500));
      expect(row()).toEqual({ present: 1, hlc_physical: 1727200011500 });
      expect(store.getEffectiveProperties(node)).toEqual([
        expect.objectContaining({ value: "xs", source: "default", boundBy: CLASS_X }),
      ]);

      // A stale remove (lower HLC than the add) is dropped: membership stands
      // and the tombstone keeps the add's HLC.
      store.apply(env("class.unassign", { objectId: node, classId: CLASS_X }, 1727200011450));
      expect(row()).toEqual({ present: 1, hlc_physical: 1727200011500 });
      expect(JSON.parse(store.getNode(node)?.class_ids ?? "[]")).toEqual([CLASS_X]);
    });

    it("an exact-HLC add beats the remove in either delivery order (add-wins)", () => {
      const store = makeStore();
      makeClass(store, CLASS_X, "X", 1727200011100);
      // Order 1: remove first (tombstones the pair), then the re-issued create
      // at the SAME (hlc, actor): the add's >= comparator wins.
      const node1 = "0192a000-0000-7000-8000-0000000003c1";
      store.apply(env("object.create", { objectId: node1, nodeType: "page" }, 1727200011300));
      store.apply(env("class.unassign", { objectId: node1, classId: CLASS_X }, 1727200011400));
      store.apply(env("object.create", { objectId: node1, classIds: [CLASS_X] }, 1727200011400));
      // Order 2: the add lands first, then the equal-HLC remove is dropped.
      const node2 = "0192a000-0000-7000-8000-0000000003c2";
      store.apply(env("object.create", { objectId: node2, nodeType: "page" }, 1727200011300));
      store.apply(env("object.create", { objectId: node2, classIds: [CLASS_X] }, 1727200011400));
      store.apply(env("class.unassign", { objectId: node2, classId: CLASS_X }, 1727200011400));
      for (const node of [node1, node2]) {
        expect(JSON.parse(store.getNode(node)?.class_ids ?? "[]")).toEqual([CLASS_X]);
      }
    });

    it("class.unassign on a missing node fails loud", () => {
      const store = makeStore();
      expect(() =>
        store.apply(
          env("class.unassign", { objectId: NODE_PAGE, classId: CLASS_X }, 1727200011000),
        ),
      ).toThrow(NotFoundError);
    });

    it("binding unset removes the derived default", () => {
      const store = makeStore();
      makeSchema(store, EFFORT, "effort", 1727200011000);
      makeClass(store, CLASS_X, "X", 1727200011100);
      bind(store, CLASS_X, EFFORT, "xs", 1727200011200);
      const node = "0192a000-0000-7000-8000-0000000003c1";
      store.apply(env("object.create", { objectId: node, nodeType: "page", classIds: [CLASS_X] }, 1727200011300));
      expect(store.getEffectiveProperties(node)).toHaveLength(1);

      store.apply(env("class.property.unset", { classId: CLASS_X, propertySchemaId: EFFORT }, 1727200011400));
      expect(store.getEffectiveProperties(node)).toEqual([]);
    });
  });

  describe("determinism", () => {
    it("reset() empties the store", () => {
      const store = makeStore();
      store.applyMany(allFixtureEnvelopes());
      expect(store.getNode(NODE_PAGE)).toBeDefined();
      store.reset();
      expect(store.getNode(NODE_PAGE)).toBeUndefined();
      expect(
        (store.database.prepare("SELECT COUNT(*) AS n FROM node").get() as { n: number }).n,
      ).toBe(0);
      // The store is usable again after a reset.
      store.applyMany(loadFixture("envelope-minimal.json"));
      expect(store.getNode(NODE_PAGE)?.node_type).toBe("page");
    });

    it("wipe + replay from stored envelopes reproduces an identical database", () => {
      const envelopes = allFixtureEnvelopes().map((e) => JSON.parse(JSON.stringify(e)));
      const store1 = makeStore();
      store1.applyMany(envelopes);

      const bytes = store1.snapshot();
      const store2 = makeStore();
      store2.applyMany(JSON.parse(JSON.stringify(envelopes)));
      expect(dumpDb(store2, { withAppliedLog: true })).toEqual(dumpDb(store1, { withAppliedLog: true }));

      // Snapshot/restore round-trips the same bytes.
      const store3 = makeStore();
      store3.restore(bytes);
      expect(dumpDb(store3, { withAppliedLog: true })).toEqual(dumpDb(store1, { withAppliedLog: true }));
      store3.close();
      store2.close();
    });
  });

  describe("object.move (reparent + ordering)", () => {
    const P = "0192a000-0000-7000-8000-000000000020";
    const A = "0192a000-0000-7000-8000-000000000021";
    const B = "0192a000-0000-7000-8000-000000000022";
    const C = "0192a000-0000-7000-8000-000000000023";

    it("fixture replay lands C under A with P = [A, B] and A = [C]", () => {
      const store = makeStore();
      store.applyMany(loadFixture("object-move.json"));
      expect(store.getNode(C)?.parent_id).toBe(A);
      expect(store.children(P).map((n) => n.id)).toEqual([A, B]);
      expect(store.children(A).map((n) => n.id)).toEqual([C]);
      // Exactly one child_order row per node — no dual-parent residue.
      const rows = store.database
        .prepare("SELECT child_id, position FROM node_child_order WHERE parent_id = ? ORDER BY position")
        .all(P);
      expect(rows).toEqual([
        { child_id: A, position: "a" },
        { child_id: B, position: "aa" },
      ]);
      expect(
        (
          store.database
            .prepare("SELECT COUNT(*) AS n FROM node_child_order WHERE child_id = ?")
            .get(C) as { n: number }
        ).n,
      ).toBe(1);
    });

    it("afterId places the node immediately after that sibling (sibling midpoint)", () => {
      const store = baseStore();
      const x = "0192a000-0000-7000-8000-0000000000e1";
      const y = "0192a000-0000-7000-8000-0000000000e2";
      const z = "0192a000-0000-7000-8000-0000000000e3";
      store.apply(env("object.create", { objectId: x, parentId: NODE_PAGE }, 1727200002000));
      store.apply(env("object.create", { objectId: y, parentId: NODE_PAGE }, 1727200002100));
      store.apply(env("object.create", { objectId: z, parentId: NODE_PAGE }, 1727200002200));
      // Enter placement: Z jumps the queue to sit right after X.
      const result = store.apply(
        env("object.move", { objectId: z, parentId: NODE_PAGE, afterId: x }, 1727200002300),
      );
      expect(result.ignored).toBe(false);
      expect(store.children(NODE_PAGE).map((n) => n.id)).toEqual([x, z, y]);
      const position = store.database
        .prepare("SELECT position FROM node_child_order WHERE parent_id = ? AND child_id = ?")
        .get(NODE_PAGE, z) as { position: string };
      expect(position.position).toBe("a`"); // midpoint between "a" and "aa"
    });

    it("append-at-end when afterId is the last sibling", () => {
      const store = baseStore();
      const x = "0192a000-0000-7000-8000-0000000000e1";
      const y = "0192a000-0000-7000-8000-0000000000e2";
      store.apply(env("object.create", { objectId: x, parentId: NODE_PAGE }, 1727200002000));
      store.apply(env("object.create", { objectId: y, parentId: NODE_PAGE }, 1727200002100));
      store.apply(
        env("object.move", { objectId: x, parentId: NODE_PAGE, afterId: y }, 1727200002200),
      );
      expect(store.children(NODE_PAGE).map((n) => n.id)).toEqual([y, x]);
      const position = store.database
        .prepare("SELECT position FROM node_child_order WHERE parent_id = ? AND child_id = ?")
        .get(NODE_PAGE, x) as { position: string };
      expect(position.position).toBe("aaa");
    });

    it("falls back to a plain append when afterId is not a sibling (defensive)", () => {
      const store = baseStore();
      const x = "0192a000-0000-7000-8000-0000000000e1";
      const y = "0192a000-0000-7000-8000-0000000000e2";
      // NODE_BOOK is not a child of NODE_PAGE.
      store.apply(env("object.create", { objectId: x, parentId: NODE_PAGE }, 1727200002000));
      store.apply(env("object.create", { objectId: y, parentId: NODE_PAGE }, 1727200002100));
      store.apply(
        env(
          "object.move",
          { objectId: y, parentId: NODE_PAGE, afterId: NODE_BOOK },
          1727200002200,
        ),
      );
      expect(store.children(NODE_PAGE).map((n) => n.id)).toEqual([x, y]);
    });

    it("root move of a block throws the placement CHECK as a typed error", () => {
      const store = baseStore();
      const block = "0192a000-0000-7000-8000-0000000000e1";
      store.apply(env("object.create", { objectId: block, parentId: NODE_PAGE }, 1727200002000));
      expect(() =>
        store.apply(env("object.move", { objectId: block, parentId: null }, 1727200002100)),
      ).toThrow(CheckConstraintError);
      // The throw rolls back: still parented, one child_order row.
      expect(store.getNode(block)?.parent_id).toBe(NODE_PAGE);
      expect(
        (
          store.database
            .prepare("SELECT COUNT(*) AS n FROM node_child_order WHERE child_id = ?")
            .get(block) as { n: number }
        ).n,
      ).toBe(1);
    });

    it("root move of a page is legal and drops its child_order row", () => {
      const store = baseStore();
      const sub = "0192a000-0000-7000-8000-0000000000e1";
      store.apply(
        env("object.create", { objectId: sub, nodeType: "page", parentId: NODE_PAGE }, 1727200002000),
      );
      store.apply(env("object.move", { objectId: sub, parentId: null }, 1727200002100));
      expect(store.getNode(sub)?.parent_id).toBeNull();
      expect(
        (
          store.database
            .prepare("SELECT COUNT(*) AS n FROM node_child_order WHERE child_id = ?")
            .get(sub) as { n: number }
        ).n,
      ).toBe(0);
    });

    it("rejects a class parent with the cross-row move guard", () => {
      const store = baseStore();
      const classId = "c0000000-0000-7000-8000-0000000000c1";
      const block = "0192a000-0000-7000-8000-0000000000e1";
      store.apply(env("class.create", { classId, contentAst: [{ type: "text", text: "Tag" }]}, 1727200001500));
      store.apply(env("object.create", { objectId: block, parentId: NODE_PAGE }, 1727200002000));
      expect(() =>
        store.apply(env("object.move", { objectId: block, parentId: classId }, 1727200002100)),
      ).toThrow(MoveGuardError);
    });

    it("rejects moving a node under its own descendant (cycle guard)", () => {
      const store = baseStore();
      const outer = "0192a000-0000-7000-8000-0000000000e1";
      const inner = "0192a000-0000-7000-8000-0000000000e2";
      store.apply(env("object.create", { objectId: outer, parentId: NODE_PAGE }, 1727200002000));
      store.apply(env("object.create", { objectId: inner, parentId: outer }, 1727200002100));
      expect(() =>
        store.apply(env("object.move", { objectId: outer, parentId: inner }, 1727200002200)),
      ).toThrow(MoveGuardError);
    });

    it("re-parenting keeps ancestor stats correct on both sides", () => {
      const store = makeStore();
      store.applyMany(loadFixture("object-move.json"));
      // P lost C as a direct child but keeps it as a descendant through A
      // (P: 2 children, 3 descendants; A: 1 child, 1 descendant).
      const statsOf = (id: string) =>
        store.database
          .prepare("SELECT child_count, descendant_count FROM node_stats WHERE node_id = ?")
          .get(id) as { child_count: number; descendant_count: number };
      expect(statsOf(P)).toEqual({ child_count: 2, descendant_count: 3 });
      expect(statsOf(A)).toEqual({ child_count: 1, descendant_count: 1 });
    });

    it("an older move re-applied after a newer one is dropped by row LWW", () => {
      const store = baseStore();
      const block = "0192a000-0000-7000-8000-0000000000e1";
      store.apply(env("object.create", { objectId: block, parentId: NODE_PAGE }, 1727200002000));
      const older = env("object.move", { objectId: block, parentId: NODE_BOOK }, 1727200002100);
      const newer = env("object.move", { objectId: block, parentId: NODE_PAGE }, 1727200002200);
      // newTarget: move back under NODE_PAGE first (as a child order change).
      store.apply(older);
      expect(store.getNode(block)?.parent_id).toBe(NODE_BOOK);
      store.apply(newer);
      expect(store.getNode(block)?.parent_id).toBe(NODE_PAGE);
      // Replay the older move with a fresh envelope id: must not regress.
      const replay = store.apply(
        env("object.move", { objectId: block, parentId: NODE_BOOK }, 1727200002100),
      );
      expect(replay.ignored).toBe(true);
      expect(store.getNode(block)?.parent_id).toBe(NODE_PAGE);
      expect(
        (
          store.database
            .prepare("SELECT COUNT(*) AS n FROM node_child_order WHERE child_id = ?")
            .get(block) as { n: number }
        ).n,
      ).toBe(1);
    });
  });

  describe("object lifecycle", () => {
    it("soft delete trashes the subtree; permanent delete hard-removes it", () => {
      const store = baseStore();
      const child = "0192a000-0000-7000-8000-0000000000d1";
      store.apply(
        env(
          "object.create",
          { objectId: child, parentId: NODE_PAGE, contentAst: [{ type: "text", text: "child block" }] },
          1727200002000,
        ),
      );
      expect(store.children(NODE_PAGE).map((n) => n.id)).toEqual([child]);
      // Child order appends: deterministic fractional position.
      const order = store.database
        .prepare("SELECT position FROM node_child_order WHERE parent_id = ? AND child_id = ?")
        .get(NODE_PAGE, child) as { position: string };
      expect(order.position).toBe("a");

      store.apply(env("object.delete", { objectId: NODE_PAGE }, 1727200003000));
      expect(store.getNode(NODE_PAGE)?.is_active).toBe(0);
      expect(store.getNode(child)?.is_active).toBe(0);
      const trash = store.database
        .prepare("SELECT deleted_at, is_permanent FROM trash WHERE node_id = ?")
        .get(NODE_PAGE) as { deleted_at: string; is_permanent: number };
      expect(trash.deleted_at).toBe(new Date(1727200003000).toISOString());
      expect(trash.is_permanent).toBe(0);

      store.apply(env("object.delete", { objectId: NODE_PAGE, permanent: true }, 1727200004000));
      expect(store.getNode(NODE_PAGE)).toBeUndefined();
      expect(store.getNode(child)).toBeUndefined();
      expect(store.children(NODE_PAGE)).toEqual([]);
      expect(store.search("child")).toEqual([]);
      const permanentTrash = store.database
        .prepare("SELECT is_permanent FROM trash WHERE node_id = ?")
        .get(NODE_PAGE) as { is_permanent: number };
      expect(permanentTrash.is_permanent).toBe(1);
    });

    it("re-issuing object.create on an existing id is a strict tree no-op", () => {
      const store = baseStore();
      const child = "0192a000-0000-7000-8000-0000000000d1";
      store.apply(
        env(
          "object.create",
          { objectId: child, parentId: NODE_PAGE, contentAst: [{ type: "text", text: "child block" }] },
          1727200002000,
        ),
      );
      const before = dumpDb(store);
      // Replay the create against a DIFFERENT parent with payload drift
      // (name/content carried by the re-issue): the earlier half-apply added
      // a second child_order row and left node.parent_id stale (the node
      // rendered under TWO parents).
      const result = store.apply(
        env(
          "object.create",
          { objectId: child, parentId: NODE_BOOK, contentAst: [{ type: "text", text: "replay drift" }] },
          1727200003000,
        ),
      );
      expect(result.ignored).toBe(true);
      expect(store.getNode(child)?.parent_id).toBe(NODE_PAGE);
      expect(store.getNode(child)?.name).toBeNull();
      expect(
        (
          store.database
            .prepare("SELECT COUNT(*) AS n FROM node_child_order WHERE child_id = ?")
            .get(child) as { n: number }
        ).n,
      ).toBe(1);
      expect(dumpDb(store)).toEqual(before);
    });

    it("re-create still seeds classIds into the OR-Set (convergence carrier), without touching the tree", () => {
      const store = baseStore();
      const child = "0192a000-0000-7000-8000-0000000000d1";
      store.apply(env("object.create", { objectId: child, parentId: NODE_PAGE }, 1727200002000));
      const result = store.apply(
        env(
          "object.create",
          { objectId: child, parentId: NODE_BOOK, classIds: [BOOK_CLASS] },
          1727200003000,
        ),
      );
      expect(result.ignored).toBe(true);
      // Class membership unioned (add-wins OR-Set); the tree did not move.
      expect(JSON.parse(store.getNode(child)?.class_ids ?? "[]")).toEqual([BOOK_CLASS]);
      expect(store.getNode(child)?.parent_id).toBe(NODE_PAGE);
      expect(
        (
          store.database
            .prepare("SELECT COUNT(*) AS n FROM node_child_order WHERE child_id = ?")
            .get(child) as { n: number }
        ).n,
      ).toBe(1);
    });

    it("promotes a block to a page and demotes it back in place", () => {
      const store = makeStore();
      const parent = "0192a000-0000-7000-8000-0000000000f0";
      store.apply(createPage(parent, 1727200000000));
      const child = "0192a000-0000-7000-8000-0000000000f1";
      // No payload nodeType: the applier defaults a child to 'block'.
      store.apply(env("object.create", { objectId: child, parentId: parent }, 1727200001000));
      expect(store.getNode(child)?.node_type).toBe("block");
      store.apply(env("object.update", { objectId: child, nodeType: "page" }, 1727200002000));
      expect(store.getNode(child)?.node_type).toBe("page");
      // Demotion back to block is legal because the node has a parent.
      store.apply(env("object.update", { objectId: child, nodeType: "block" }, 1727200003000));
      expect(store.getNode(child)?.node_type).toBe("block");
    });

    it("contentDeltaB64 without a contentAst mirror fails loud", () => {
      const store = baseStore();
      expect(() =>
        store.apply(
          env(
            "object.update",
            { objectId: NODE_BOOK, contentDeltaB64: "AAAA" },
            1727200002000,
          ),
        ),
      ).toThrow(UnsupportedCarrierError);
    });

    it("asset attach/detach maintains node_asset rows", () => {
      const store = baseStore();
      const assetId = "0192a000-0000-7000-8000-0000000000e1";
      store.apply(
        env(
          "asset.attach",
          {
            objectId: NODE_BOOK,
            assetId,
            hash: "a".repeat(64),
            mimeType: "image/png",
            size: 1234,
            originalName: "cover.png",
          },
          1727200002000,
        ),
      );
      const row = store.database
        .prepare("SELECT hash, original_name FROM node_asset WHERE node_id = ? AND asset_id = ?")
        .get(NODE_BOOK, assetId) as { hash: string; original_name: string };
      expect(row.hash).toBe("a".repeat(64));
      expect(row.original_name).toBe("cover.png");
      store.apply(env("asset.detach", { objectId: NODE_BOOK, assetId }, 1727200003000));
      expect(
        (store.database.prepare("SELECT COUNT(*) AS n FROM node_asset").get() as { n: number }).n,
      ).toBe(0);
    });
  });

  describe("search (FTS)", () => {
    it("finds the block containing 'Kuhn'", () => {
      const store = baseStoreWithBlock();
      store.applyMany(loadFixture("typed-link-mark.json"));
      expect(store.search("Kuhn")).toEqual([{ nodeId: NODE_BLOCK }]);
    });

    it("prefix-AND matches across terms", () => {
      const store = baseStoreWithBlock();
      store.applyMany(loadFixture("typed-link-mark.json"));
      expect(store.search("Kuhn Scient")).toEqual([{ nodeId: NODE_BLOCK }]);
      expect(store.search("Kuhn absentterm")).toEqual([]);
    });

    it("indexes text inside quote tokens", () => {
      const store = baseStore();
      store.apply(
        env(
          "object.update",
          {
            objectId: NODE_BOOK,
            contentAst: [
              {
                type: "quote",
                children: [{ type: "text", text: "Paradigms are not reducible to rules" }],
              },
            ],
          },
          1727200009000,
        ),
      );
      expect(store.search("Paradigms")).toEqual([{ nodeId: NODE_BOOK }]);
      expect(store.search("Paradigms rules")).toEqual([{ nodeId: NODE_BOOK }]);
    });

    it("excludes soft-deleted nodes from search results", () => {
      const store = baseStoreWithBlock();
      store.applyMany(loadFixture("typed-link-mark.json"));
      store.apply(env("object.delete", { objectId: NODE_BLOCK }, 1727200010000));
      expect(store.search("Kuhn")).toEqual([]);
    });

    it("finds a page by its title text (title-is-content: one indexed text run)", () => {
      const store = baseStore();
      const quantum = "0192a000-0000-7000-8000-0000000000d1";
      store.apply(
        env(
          "object.create",
          {
            objectId: quantum,
            nodeType: "page",
            // Title and prose fold into the page's single indexed text run.
            contentAst: [{ type: "text", text: "Quantum" }, { type: "text", text: "unrelated prose" }],
          },
          1727200002000,
        ),
      );
      // Title-term match.
      expect(store.search("Quantum")).toEqual([{ nodeId: quantum }]);
      // Content-term search hits the same indexed row.
      expect(store.search("unrelated")).toEqual([{ nodeId: quantum }]);
    });

    it("indexes a name-only page and reindexes on rename (name LWW)", () => {
      const store = baseStore();
      const id = "0192a000-0000-7000-8000-0000000000d1";
      store.apply(env("object.create", { objectId: id, nodeType: "page", contentAst: [{ type: "text", text: "Alpha" }]}, 1727200002000));
      expect(store.search("Alpha")).toEqual([{ nodeId: id }]);
      // Name LWW update: the new name is indexed, the old one stops matching.
      store.apply(env("object.update", { objectId: id, contentAst: [{ type: "text", text: "Beta" }]}, 1727200003000));
      expect(store.search("Alpha")).toEqual([]);
      expect(store.search("Beta")).toEqual([{ nodeId: id }]);
      // A lower-HLC rename is dropped by LWW: the index keeps the winner.
      store.apply(env("object.update", { objectId: id, contentAst: [{ type: "text", text: "Gamma" }]}, 1727200002500));
      expect(store.search("Gamma")).toEqual([]);
      expect(store.search("Beta")).toEqual([{ nodeId: id }]);
    });

    it("matches hyphenated identifiers across the punctuation boundary", () => {
      const store = baseStore();
      const id = "0192a000-0000-7000-8000-0000000000d1";
      store.apply(
        env(
          "object.create",
          {
            objectId: id,
            nodeType: "page",
            contentAst: [{ type: "text", text: "Packaging validation per ISO 11607-1" }],
          },
          1727200002000,
        ),
      );
      // unicode61 indexes "11607-1" as the tokens 11607 and 1; the query must
      // split at the same boundary instead of merging into "116071".
      expect(store.search("11607-1")).toEqual([{ nodeId: id }]);
      expect(store.search("ISO 11607")).toEqual([{ nodeId: id }]);
    });
  });

  describe("class search indexing", () => {
    it("classes are findable by name at create and after rename", () => {
      const store = baseStore();
      const id = "c0000000-0000-7000-8000-0000000000c9";
      store.apply(env("class.create", { classId: id, contentAst: [{ type: "text", text: "Zymurgy" }]}, 1727200001500));
      expect(store.search("Zymurgy").map((hit) => hit.nodeId)).toContain(id);
      store.apply(env("class.update", { classId: id, contentAst: [{ type: "text", text: "Zymurgics" }]}, 1727200001600));
      expect(store.search("Zymurgy")).toEqual([]);
      expect(store.search("Zymurgics").map((hit) => hit.nodeId)).toContain(id);
    });
  });

  describe("local op log (durable offline backlog)", () => {
    it("records local envelopes, lists unpushed, marks pushed, prunes", () => {
      const store = baseStore();
      const a = env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000e1", nodeType: "page", contentAst: [{ type: "text", text: "A" }]}, 1727200002000);
      const b = env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000e2", nodeType: "page", contentAst: [{ type: "text", text: "B" }]}, 1727200003000);
      store.recordLocalEnvelope(a);
      store.recordLocalEnvelope(b);
      // Idempotent: recording the same envelope twice changes nothing.
      store.recordLocalEnvelope(a);
      const unpushed = store.unpushedEnvelopes();
      expect(unpushed.map((e) => (e as { id: string }).id)).toEqual([a.id, b.id]);
      store.markLocalEnvelopesPushed([a.id]);
      expect(store.unpushedEnvelopes().map((e) => (e as { id: string }).id)).toEqual([b.id]);
      store.prunePushedLocalEnvelopes();
      expect(store.unpushedEnvelopes().map((e) => (e as { id: string }).id)).toEqual([b.id]);
      store.markLocalEnvelopesPushed([b.id]);
      store.prunePushedLocalEnvelopes();
      expect(store.unpushedEnvelopes()).toEqual([]);
    });
  });

  describe("backlinksWithRollup (source-side containment roll-up, 01 §8)", () => {
    const FRANCE = "0192a000-0000-7000-8000-0000000000e2";
    const PARIS = "0192a000-0000-7000-8000-0000000000e3";
    const SPAIN = "0192a000-0000-7000-8000-0000000000e4";
    const NOTES = "0192a000-0000-7000-8000-0000000000e5";

    interface RollupRow {
      source_id: string;
      target_id: string;
      kind: string;
      distance: number;
    }

    /** France page with child block; Paris, Spain, Notes are separate roots. */
    function travelStore(): Store {
      const store = makeStore();
      store.apply(env("object.create", { objectId: FRANCE, nodeType: "page", contentAst: [{ type: "text", text: "France" }]}, 1727200001000));
      store.apply(env("object.create", { objectId: PARIS, nodeType: "page", contentAst: [{ type: "text", text: "Paris" }]}, 1727200001100));
      store.apply(env("object.create", { objectId: SPAIN, nodeType: "page", contentAst: [{ type: "text", text: "Spain" }]}, 1727200001200));
      store.apply(env("object.create", { objectId: NOTES, nodeType: "page", contentAst: [{ type: "text", text: "Notes" }]}, 1727200001300));
      return store;
    }

    function mention(target: string, text: string) {
      return { type: "mention", targetNodeId: target, text };
    }

    it("a block inside France linking Paris lists in BOTH: containment for France, direct for Paris", () => {
      const store = travelStore();
      // Block B under France links Paris — TWICE (two edge instances must
      // collapse into one roll-up row per source+kind).
      const b = "0192a000-0000-7000-8000-0000000000f1";
      store.apply(
        env(
          "object.create",
          { objectId: b, parentId: FRANCE, contentAst: [mention(PARIS, "Paris"), mention(PARIS, "Paris")] },
          1727200002000,
        ),
      );

      // France: B is inside France's subtree and Paris is outside it.
      const franceRollup = store.backlinksWithRollup(FRANCE) as RollupRow[];
      expect(franceRollup.map((r) => ({ source: r.source_id, target: r.target_id, kind: r.kind, distance: r.distance }))).toEqual([
        { source: b, target: PARIS, kind: "containment", distance: 1 },
      ]);
      // Paris: the edge targets Paris directly.
      const parisRollup = store.backlinksWithRollup(PARIS) as RollupRow[];
      expect(parisRollup.map((r) => ({ source: r.source_id, kind: r.kind, distance: r.distance }))).toEqual([
        { source: b, kind: "direct", distance: 0 },
      ]);
      // Direct-only surfaces are unchanged: backlinks() and the materialized
      // node_stats.backlink_count (the gutter badge) count edges TARGETING
      // the node only — France gains no badge from its subtree's outward link.
      expect(store.backlinks(FRANCE)).toEqual([]);
      const statsOf = (id: string) =>
        (store.database.prepare("SELECT backlink_count AS n FROM node_stats WHERE node_id = ?").get(id) as { n: number }).n;
      expect(statsOf(FRANCE)).toBe(0);
      expect(statsOf(PARIS)).toBe(1);

      // Depth: a block nested under B (grandchild of France) rolls up at
      // distance 2, after the distance-1 row.
      const b4 = "0192a000-0000-7000-8000-0000000000f2";
      store.apply(
        env("object.create", { objectId: b4, parentId: b, contentAst: [mention(PARIS, "Paris")] }, 1727200002100),
      );
      const deep = store.backlinksWithRollup(FRANCE) as RollupRow[];
      expect(deep.map((r) => ({ source: r.source_id, kind: r.kind, distance: r.distance }))).toEqual([
        { source: b, kind: "containment", distance: 1 },
        { source: b4, kind: "containment", distance: 2 },
      ]);
    });

    it("outward-only: outside sources and intra-subtree links never list the container", () => {
      const store = travelStore();
      const b = "0192a000-0000-7000-8000-0000000000f1";
      store.apply(
        env("object.create", { objectId: b, parentId: FRANCE, contentAst: [mention(PARIS, "Paris")] }, 1727200002000),
      );
      // Spain's block links Paris: direct on Paris, but Spain is outside
      // France's subtree — never in France's list.
      const spainBlock = "0192a000-0000-7000-8000-0000000000f2";
      store.apply(
        env("object.create", { objectId: spainBlock, parentId: SPAIN, contentAst: [mention(PARIS, "Paris")] }, 1727200002100),
      );
      // Intra-France link: B2 (under France) links B3 (also under France) —
      // the target is inside France's subtree, so France does not list it.
      const b3 = "0192a000-0000-7000-8000-0000000000f3";
      const b2 = "0192a000-0000-7000-8000-0000000000f4";
      store.apply(env("object.create", { objectId: b3, parentId: FRANCE, contentAst: [] }, 1727200002200));
      store.apply(
        env("object.create", { objectId: b2, parentId: FRANCE, contentAst: [mention(b3, "B3")] }, 1727200002300),
      );

      const franceRollup = store.backlinksWithRollup(FRANCE) as RollupRow[];
      expect(franceRollup.map((r) => r.source_id)).toEqual([b]);
      // Paris sees both outside blocks as direct edges.
      const parisRollup = store.backlinksWithRollup(PARIS) as RollupRow[];
      expect(parisRollup.map((r) => ({ source: r.source_id, kind: r.kind }))).toEqual([
        { source: b, kind: "direct" },
        { source: spainBlock, kind: "direct" },
      ]);
      // B3's own backlink is the intra link (direct on B3) — sanity.
      expect((store.backlinks(b3) as Array<{ source_id: string }>).map((r) => r.source_id)).toEqual([b2]);
    });

    it("direct edges order first; the badge counts direct edges only (list may exceed it)", () => {
      const store = travelStore();
      const b = "0192a000-0000-7000-8000-0000000000f1";
      store.apply(
        env("object.create", { objectId: b, parentId: FRANCE, contentAst: [mention(PARIS, "Paris")] }, 1727200002000),
      );
      const notesBlock = "0192a000-0000-7000-8000-0000000000f2";
      store.apply(
        env("object.create", { objectId: notesBlock, parentId: NOTES, contentAst: [mention(FRANCE, "France")] }, 1727200002100),
      );

      const rollup = store.backlinksWithRollup(FRANCE) as RollupRow[];
      expect(rollup.map((r) => ({ source: r.source_id, kind: r.kind, distance: r.distance }))).toEqual([
        { source: notesBlock, kind: "direct", distance: 0 },
        { source: b, kind: "containment", distance: 1 },
      ]);
      // Badge divergence: the list has two rows; the direct-only badge is 1.
      const stats = store.database
        .prepare("SELECT backlink_count AS n FROM node_stats WHERE node_id = ?")
        .get(FRANCE) as { n: number };
      expect(stats.n).toBe(1);

      // France's OWN outward link (France linking Paris) must not list France
      // in its own backlinks — only strictly-inside sources roll up.
      store.apply(
        env("object.update", { objectId: FRANCE, contentAst: [mention(PARIS, "Paris")] }, 1727200002200),
      );
      const after = store.backlinksWithRollup(FRANCE) as RollupRow[];
      expect(after.map((r) => ({ source: r.source_id, kind: r.kind }))).toEqual([
        { source: notesBlock, kind: "direct" },
        { source: b, kind: "containment" },
      ]);
    });
  });
});

// --- sql.js-specific coverage ----------------------------------------------------

describe("sql.js snapshot round-trip", () => {
  it("snapshot() bytes restore into a fresh in-memory sql.js database", () => {
    const source = Store.open(sqljsBackend(sqlModule));
    source.applyMany(allFixtureEnvelopes());

    const bytes = source.snapshot();
    expect(bytes.length).toBeGreaterThan(0);

    const restored = Store.open(sqljsBackend(sqlModule));
    restored.restore(bytes);

    // Full derived state, including the application log, survives the byte
    // round-trip (restore_epoch in sync_state is environmental and excluded
    // by dumpDb).
    expect(dumpDb(restored, { withAppliedLog: true })).toEqual(
      dumpDb(source, { withAppliedLog: true }),
    );
    expect(restored.getNode(NODE_PAGE)?.node_type).toBe("page");

    restored.close();
    source.close();
  });
});

// --- cross-backend restore (server FTS5 snapshot -> sql.js FTS4 client) --------

describe("cross-backend snapshot restore", () => {
  const MIGRATED_PAGE = "0192a000-0000-7000-8000-0000000000f0";

  function seededServerStore(): Store {
    const store = Store.open(betterSqlite3Backend(":memory:"));
    store.applyMany([
      createPage(MIGRATED_PAGE, 1727200000000),
      env(
        "object.update",
        { objectId: MIGRATED_PAGE, nodeType: "page", contentAst: [{ type: "text", text: "20180900 daily note" }] },
        1727200001000,
      ),
    ]);
    return store;
  }

  it("server (FTS5) snapshot restores into sql.js (FTS4) with data and index intact", () => {
    const server = seededServerStore();
    expect(server.search("20180900").map((h) => h.nodeId)).toContain(MIGRATED_PAGE);
    const counts = (store: Store) => ({
      nodes: (store.database.prepare("SELECT COUNT(*) AS n FROM node").get() as { n: number }).n,
      pages: (
        store.database
          .prepare("SELECT COUNT(*) AS n FROM node WHERE node_type='page' AND is_active=1")
          .get() as { n: number }
      ).n,
      childOrder: (store.database.prepare("SELECT COUNT(*) AS n FROM node_child_order").get() as { n: number })
        .n,
      properties: (store.database.prepare("SELECT COUNT(*) AS n FROM property_value").get() as { n: number })
        .n,
    });
    const before = counts(server);
    const bytes = server.snapshot();
    server.close();

    const client = Store.open(sqljsBackend(sqlModule));
    client.restore(bytes);

    // Node data survives the module-free drop + export/re-open sequence
    // (regression guard: the rebuilt connection must carry the snapshot's
    // full data, not just the re-created index).
    expect(counts(client)).toEqual(before);

    // The rebuilt index finds the migrated content — previously every search
    // threw "no such module: fts5" and surfaced as silent "No results.".
    expect(client.search("20180900").map((h) => h.nodeId)).toContain(MIGRATED_PAGE);
    expect(client.search("daily").map((h) => h.nodeId)).toContain(MIGRATED_PAGE);
    // ...and it stays maintainable: local writes keep the index correct.
    client.apply(
      env(
        "object.update",
        { objectId: MIGRATED_PAGE, nodeType: "page", contentAst: [{ type: "text", text: "clasificaciones taxonomy" }] },
        1727200002000,
      ),
    );
    expect(client.search("clasificaciones").map((h) => h.nodeId)).toContain(MIGRATED_PAGE);
    // Node data itself is untouched by the rebuild.
    expect(client.getNode(MIGRATED_PAGE)?.node_type).toBe("page");
    // The docid index must exist: without it, common-prefix MATCH queries
    // degrade to a full docid-map scan per matched row (query-of-death).
    const indexes = client.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_search_index%'")
      .all() as { name: string }[];
    expect(indexes.map((r) => r.name)).toContain("idx_search_index_docid_docid");
    client.close();
  });

  it("is deterministic: the rebuilt index matches a fresh sql.js rebuild of the same envelopes", () => {
    const server = seededServerStore();
    const bytes = server.snapshot();
    server.close();

    const restored = Store.open(sqljsBackend(sqlModule));
    restored.restore(bytes);
    const fresh = Store.open(sqljsBackend(sqlModule));
    fresh.applyMany([
      createPage(MIGRATED_PAGE, 1727200000000),
      env(
        "object.update",
        { objectId: MIGRATED_PAGE, nodeType: "page", contentAst: [{ type: "text", text: "20180900 daily note" }] },
        1727200001000,
      ),
    ]);

    const docids = (store: Store) =>
      (
        store.database
          .prepare("SELECT node_id, docid FROM search_index_docid ORDER BY node_id")
          .all() as { node_id: string; docid: number }[]
      ).map((r) => r.node_id);
    const indexed = (store: Store) =>
      (store.database.prepare("SELECT content FROM search_index").all() as { content: string }[]).map(
        (r) => r.content,
      );
    expect(docids(restored)).toEqual(docids(fresh));
    expect(indexed(restored).sort()).toEqual(indexed(fresh).sort());
    restored.close();
    fresh.close();
  });

  it("reverse direction (sql.js FTS4 snapshot into better-sqlite3 FTS5) stays queryable", () => {
    const source = Store.open(sqljsBackend(sqlModule));
    source.applyMany([
      createPage(MIGRATED_PAGE, 1727200000000),
      env(
        "object.update",
        { objectId: MIGRATED_PAGE, nodeType: "page", contentAst: [{ type: "text", text: "sqlite cross-backend" }] },
        1727200001000,
      ),
    ]);
    expect(source.search("backend").map((h) => h.nodeId)).toContain(MIGRATED_PAGE);
    const bytes = source.snapshot();
    source.close();

    const restored = Store.open(betterSqlite3Backend(":memory:"));
    restored.restore(bytes);
    expect(restored.search("backend").map((h) => h.nodeId)).toContain(MIGRATED_PAGE);
    restored.close();
  });
});

for (const adapter of adapters) {
  describe(`class delete on ${adapter.name} strips membership`, () => {
    it("class.delete removes the class from every node's class_ids", () => {
      const store = Store.open(adapter.makeBackend());
      const page = "0192a000-0000-7000-8000-000000000501";
      const cls = "0192a000-0000-7000-8000-000000000502";
      store.apply(env("object.create", { objectId: page, nodeType: "page", contentAst: [{ type: "text", text: "P" }]}, 1727200001000));
      store.apply(env("class.create", { classId: cls, contentAst: [{ type: "text", text: "Genre" }]}, 1727200001100));
      store.apply(env("object.create", { objectId: page, nodeType: "page", classIds: [cls] }, 1727200001200));
      expect(store.getNode(page)!.class_ids).toBe(JSON.stringify([cls]));
      store.apply(env("class.delete", { classId: cls }, 1727200001300));
      expect(store.getNode(page)!.class_ids).toBe("[]");
      store.close();
    });
  });
}

for (const adapter of adapters) {
  describe(`tags on ${adapter.name} (page-scoped page assignments)`, () => {
    it("assign via create carrier, unassign tombstones, re-add wins; tag_ids derived", () => {
      const store = Store.open(adapter.makeBackend());
      const page = "0192a000-0000-7000-8000-000000000301";
      const tagA = "0192a000-0000-7000-8000-000000000302";
      const tagB = "0192a000-0000-7000-8000-000000000303";
      store.apply(env("object.create", { objectId: page, nodeType: "page", contentAst: [{ type: "text", text: "P" }]}, 1727200001000));
      store.apply(env("object.create", { objectId: tagA, nodeType: "page", contentAst: [{ type: "text", text: "tag A" }]}, 1727200001100));
      store.apply(env("object.create", { objectId: tagB, nodeType: "page", contentAst: [{ type: "text", text: "tag B" }]}, 1727200001200));
      // Assign: the create carrier re-issue (same pattern as classes).
      store.apply(env("object.create", { objectId: page, nodeType: "page", tagIds: [tagA, tagB] }, 1727200002000));
      expect(store.getNode(page)!.tag_ids).toBe(JSON.stringify([tagA, tagB].sort()));
      // Unassign tombstones the pair.
      store.apply(env("tag.unassign", { objectId: page, tagId: tagA }, 1727200003000));
      expect(store.getNode(page)!.tag_ids).toBe(JSON.stringify([tagB]));
      // A stale re-add (lower HLC than the remove) loses.
      store.apply(env("object.create", { objectId: page, nodeType: "page", tagIds: [tagA] }, 1727200002500));
      expect(store.getNode(page)!.tag_ids).toBe(JSON.stringify([tagB]));
      // A newer re-add wins.
      store.apply(env("object.create", { objectId: page, nodeType: "page", tagIds: [tagA] }, 1727200004000));
      expect(store.getNode(page)!.tag_ids).toBe(JSON.stringify([tagA, tagB].sort()));
      store.close();
    });
  });
}

function makeBackendForRestore(): StoreBackend {
  return adapters[0]!.makeBackend();
}

describe("restore migrates older-schema snapshots", () => {
  it("a pre-tags snapshot restores with class_ids intact and tag_ids added", () => {
    // Build a current store with a class assignment, then downgrade its bytes
    // to a pre-tags schema (drop tag_ids, stamp v5) to simulate an old
    // snapshot, and restore into a fresh store.
    const source = Store.open(makeBackendForRestore());
    const page = "0192a000-0000-7000-8000-000000000401";
    const cls = "0192a000-0000-7000-8000-000000000402";
    source.apply(env("object.create", { objectId: page, nodeType: "page", contentAst: [{ type: "text", text: "P" }]}, 1727200001000));
    source.apply(env("class.create", { classId: cls, contentAst: [{ type: "text", text: "Genre" }]}, 1727200001100));
    source.apply(env("object.create", { objectId: page, nodeType: "page", classIds: [cls] }, 1727200001200));
    const bytes = source.database.serialize!();
    source.close();

    // Downgrade: strip tag_ids and stamp user_version 5.
    const downgraded = Store.open(makeBackendForRestore());
    downgraded.restore(bytes);
    downgraded.database.exec("ALTER TABLE node DROP COLUMN tag_ids");
    downgraded.database.pragma("user_version = 5");
    const oldBytes = downgraded.database.serialize!();
    downgraded.close();

    const restored = Store.open(makeBackendForRestore());
    restored.restore(oldBytes);
    expect(restored.getNode(page)!.class_ids).toBe(JSON.stringify([cls]));
    const columns = restored.database.prepare("PRAGMA table_info(node)").all() as { name: string }[];
    expect(columns.some((c) => c.name === "tag_ids")).toBe(true);
    restored.close();
  });
});
