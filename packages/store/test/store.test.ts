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
  CycleError,
  LockedSystemClassError,
  migrate,
  MoveGuardError,
  NotFoundError,
  PropertyValueShapeError,
  SCHEMA_VERSION,
  Store,
  SystemExtendsLockError,
  UnsupportedCarrierError,
} from "../src/index.js";
import { betterSqlite3Backend } from "../src/adapters/better-sqlite3.js";
import { sqljsBackend } from "../src/adapters/sqljs.js";
import { rebuildEdges } from "../src/edges.js";

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
 * loud by design; class-extends-system-lock.json pins the system-extends
 * lock's reject tail (detach/extra-parent/deviate) after an accepting prefix
 * — all applied deliberately in their own tests;
 * is-embedded-parent-page.json claims the render bit
 * under a block parent and fails loud by design;
 * property-validation-rules.json pins its reject tail (below-min/above-max,
 * pattern rejects, one bad multi element, one un compilable pattern) after
 * an accepting prefix — all applied deliberately in their own tests;
 * object-delete-class-routing.json pins the locked-system-class delete arm
 * (LockedSystemClassError) after its accepting prefix — the arms are
 * asserted deliberately in the routing suite below). */
const REPLAY_EXCLUDED_FIXTURES = new Set([
  "class-extends-cycle.json",
  "class-extends-system-lock.json",
  "is-embedded-parent-page.json",
  "object-delete-class-routing.json",
  "property-validation-rules.json",
]);

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

/** Parentless create: defaults to is_embedded = 0 (document chrome). */
function createPage(id: string, physical: number): Envelope {
  return env("object.create", { objectId: id }, physical);
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
      env("object.create", { objectId: NODE_BLOCK, parentId: NODE_PAGE }, 1727200000500),
    );
    return store;
  }

  describe("schema invariants (bullet-proof CHECKs)", () => {
    it("accepts a parentless non-class row with the bit either way", () => {
      const store = makeStore();
      // Parentless nodes are LEGAL under the render-state model (document
      // chrome by the second cascade branch); the placement CHECK only
      // pins classes to roots.
      expect(() =>
        store.database
          .prepare("INSERT INTO node (id, workspace_id, is_embedded) VALUES ('a', 'ws', 1)")
          .run(),
      ).not.toThrow();
      expect(() =>
        store.database
          .prepare("INSERT INTO node (id, workspace_id, is_embedded) VALUES ('a2', 'ws', 0)")
          .run(),
      ).not.toThrow();
    });

    it("rejects a class row with a parent", () => {
      const store = makeStore();
      store.database
        .prepare("INSERT INTO node (id, workspace_id, is_embedded) VALUES ('p', 'ws', 1)")
        .run();
      expect(() =>
        store.database
          .prepare("INSERT INTO node (id, workspace_id, is_class, parent_id) VALUES ('c', 'ws', 1, 'p')")
          .run(),
      ).toThrow(/CHECK constraint failed/);
    });

    it("accepts a non-class child under a class row (classes are containers, spec I4)", () => {
      const store = makeStore();
      store.database
        .prepare("INSERT INTO node (id, workspace_id, is_class) VALUES ('cls', 'ws', 1)")
        .run();
      expect(() =>
        store.database
          .prepare("INSERT INTO node (id, workspace_id, parent_id) VALUES ('child', 'ws', 'cls')")
          .run(),
      ).not.toThrow();
    });

    it("applier surfaces the class-with-parent guard as a friendly typed error", () => {
      const store = baseStore();
      store.apply(
        env("class.create", { classId: "c0000000-0000-7000-8000-0000000000c1", contentAst: [{ type: "text", text: "Tag" }]}, 1727200001500),
      );
      // The DB CHECK (is_class = 0 OR parent_id IS NULL) would fire on the
      // UPDATE; the applier surfaces it friendly, like the old class-parent
      // guard did — classes are always roots.
      expect(() =>
        store.apply(
          env("object.move", { objectId: "c0000000-0000-7000-8000-0000000000c1", parentId: NODE_PAGE }, 1727200002000),
        ),
      ).toThrow(MoveGuardError);
    });

    it("rejects moving a class under another class (class-under-class)", () => {
      const store = makeStore();
      store.apply(env("class.create", { classId: "c0000000-0000-7000-8000-0000000000c1", contentAst: [{ type: "text", text: "Work" }]}, 1727200001000));
      store.apply(env("class.create", { classId: "c0000000-0000-7000-8000-0000000000c2", contentAst: [{ type: "text", text: "Source" }]}, 1727200001100));
      expect(() =>
        store.apply(
          env("object.move", { objectId: "c0000000-0000-7000-8000-0000000000c1", parentId: "c0000000-0000-7000-8000-0000000000c2" }, 1727200001200),
        ),
      ).toThrow(MoveGuardError);
    });

    it("allows a non-class child under a class via the applier (containers)", () => {
      const store = baseStore();
      store.apply(env("class.create", { classId: "c0000000-0000-7000-8000-0000000000c1", contentAst: [{ type: "text", text: "Tag" }]}, 1727200001500));
      store.apply(
        env(
          "object.create",
          { objectId: "b0000000-0000-7000-8000-0000000000b1", parentId: "c0000000-0000-7000-8000-0000000000c1" },
          1727200002000,
        ),
      );
      const child = store.getNode("b0000000-0000-7000-8000-0000000000b1");
      expect(child?.parent_id).toBe("c0000000-0000-7000-8000-0000000000c1");
      expect(child?.is_class).toBe(0);
      // A plain parented create starts inline (block chrome).
      expect(child?.is_embedded).toBe(1);
      expect(store.children("c0000000-0000-7000-8000-0000000000c1").map((n) => n.id)).toEqual([
        "b0000000-0000-7000-8000-0000000000b1",
      ]);
    });
  });

  describe("fixture replay (canonical protocol fixtures)", () => {
    it("lands object.create fixtures as document-chrome nodes", () => {
      const store = makeStore();
      store.applyMany(allFixtureEnvelopes());
      const page = store.getNode(NODE_PAGE);
      const book = store.getNode(NODE_BOOK);
      expect(page).toMatchObject({ is_class: 0, is_embedded: 0 });
      expect(book).toMatchObject({ is_class: 0, is_embedded: 0 });
      expect(
        JSON.parse(book?.content ?? "[]").find((t: { type?: string }) => t.type === "text")?.text,
      ).toBe("The Structure of Scientific Revolutions");
      // classIds seed the OR-Set membership, projected into node.class_ids.
      expect(JSON.parse(book?.class_ids ?? "[]")).toEqual([BOOK_CLASS]);
    });

    it("object-restore.json trashes then restores: page + child active, trash row consumed", () => {
      const store = makeStore();
      store.applyMany(allFixtureEnvelopes());
      const pageId = "0192a000-0000-7000-8000-0000000000e2";
      const childId = "0192a000-0000-7000-8000-0000000000e3";
      expect(store.getNode(pageId)).toMatchObject({ is_active: 1, is_embedded: 0 });
      expect(store.getNode(childId)).toMatchObject({ is_active: 1, is_embedded: 1 });
      expect(store.children(pageId).map((n) => n.id)).toEqual([childId]);
      expect(
        store.database.prepare("SELECT 1 FROM trash WHERE node_id = ?").get(pageId),
      ).toBeUndefined();
    });

    it("trash-empty.json permanently deletes every trashed root, spares the restored-before-empty page", () => {
      const store = makeStore();
      store.applyMany(allFixtureEnvelopes());
      const a = "0192a000-0000-7000-8000-0000000000f3";
      const aChild = "0192a000-0000-7000-8000-0000000000f4";
      const b = "0192a000-0000-7000-8000-0000000000f5";
      const bChild = "0192a000-0000-7000-8000-0000000000f6";
      const c = "0192a000-0000-7000-8000-0000000000f7";
      // Both trashed subtrees (including the independently-trashed child
      // inside A's subtree) are hard-deleted.
      for (const id of [a, aChild, b, bChild]) {
        expect(store.getNode(id), id).toBeUndefined();
      }
      // The page restored before the empty survived it.
      expect(store.getNode(c)).toMatchObject({ is_active: 1, is_embedded: 0 });
      // Retention rows: exactly the two emptied roots, permanent.
      const rows = store.database
        .prepare("SELECT node_id, is_permanent FROM trash ORDER BY node_id")
        .all() as { node_id: string; is_permanent: number }[];
      const mine = rows.filter((r) => [a, aChild, b, bChild, c].includes(r.node_id));
      expect(mine).toEqual([
        { node_id: a, is_permanent: 1 },
        { node_id: b, is_permanent: 1 },
      ]);
      // Idempotent: a second empty (fresh envelope, so the applier itself
      // runs again rather than the applied_envelope dedupe) is a no-op.
      store.apply(env("trash.empty", {}, 1727200009000));
      expect(
        (store.database.prepare("SELECT COUNT(*) AS n FROM trash WHERE is_permanent = 0").get() as { n: number }).n,
      ).toBe(0);
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

    it("mines the mention token's manual isEmbedded into the edge column (default false, toggle in place)", () => {
      const store = makeStore();
      const target = "0192a000-0000-7000-8000-0000000000e9";
      const source = "0192a000-0000-7000-8000-0000000000e8";
      store.applyMany([
        createPage(target, 1727200006000),
        env(
          "object.create",
          {
            objectId: source,
            parentId: target,
            contentAst: [{ type: "mention", targetNodeId: target, text: "T" }],
          },
          1727200006100,
        ),
      ]);
      const edgeOf = () =>
        store.database
          .prepare("SELECT * FROM edge WHERE source_id = ? AND type = 'mention'")
          .get(source) as { id: string; is_embedded: number } | undefined;
      // Absent flag = an ordinary inline link (the owner ruling's default:
      // every pre-existing link reads 0).
      const before = edgeOf()!;
      expect(before.is_embedded).toBe(0);
      // The user manually embeds the link: the flag flips IN PLACE (the
      // edge identity is unchanged — no duplicate edge).
      store.apply(
        env(
          "object.update",
          {
            objectId: source,
            contentAst: [{ type: "mention", targetNodeId: target, text: "T", isEmbedded: true }],
          },
          1727200006200,
        ),
      );
      const embedded = edgeOf()!;
      expect(embedded.is_embedded).toBe(1);
      expect(embedded.id).toBe(before.id);
      expect(
        (store.database.prepare("SELECT COUNT(*) AS n FROM edge WHERE source_id = ?").get(source) as { n: number }).n,
      ).toBe(1);
      // Un-embedding flips back.
      store.apply(
        env(
          "object.update",
          {
            objectId: source,
            contentAst: [{ type: "mention", targetNodeId: target, text: "T" }],
          },
          1727200006300,
        ),
      );
      expect(edgeOf()!.is_embedded).toBe(0);
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

  describe("color grammar (token | #hex | null-clear)", () => {
    it("object.update applies preset token, custom hex, then null as a clear", () => {
      const store = baseStore();
      const page = "0192a000-0000-7000-8000-000000000510";
      const [create, ...updates] = loadFixture("object-color.json");
      store.apply(create!);
      store.apply(updates[0]!);
      expect(store.getNode(page)?.color).toBe("sky");
      store.apply(updates[1]!);
      expect(store.getNode(page)?.color).toBe("#123abc");
      store.apply(updates[2]!);
      expect(store.getNode(page)?.color).toBeNull();
    });

    it("class.create carries a token color and class.update null clears both rows", () => {
      const store = baseStore();
      const classId = "0192a000-0000-7000-8000-000000000511";
      const [create, ...updates] = loadFixture("object-color.json");
      store.apply(create!);
      const [, , , classCreate, classUpdate] = updates;
      store.apply(classCreate!);
      expect(store.getNode(classId)?.color).toBe("pink");
      expect(
        (store.database.prepare("SELECT color FROM class WHERE id = ?").get(classId) as { color: string }).color,
      ).toBe("pink");
      store.apply(classUpdate!);
      expect(store.getNode(classId)?.color).toBeNull();
      expect(
        (store.database.prepare("SELECT color FROM class WHERE id = ?").get(classId) as { color: string }).color,
      ).toBeNull();
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
        env("object.create", { objectId: NODE_BLOCK, parentId: NODE_PAGE }, 1727200000500),
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

    it("class-extends-system-lock fixture throws the lock error on apply", () => {
      const [
        createEvent,
        createMeeting,
        createUserClass,
        userExtendsMeeting,
        meetingReissue,
        meetingDetach,
        meetingExtraParent,
        eventGainsParent,
      ] = loadFixture("class-extends-system-lock.json");
      const eventId = "00000000-0000-0000-0001-000000000040";
      const meetingId = "00000000-0000-0000-0001-000000000039";
      const userClassId = "0192a000-0000-7000-8000-0000000000e1";
      const store = makeStore();
      // The prefix applies cleanly: user classes extend system bases, and an
      // idempotent re-issue of the seeded edge (the seed/ensure convergence
      // path) applies.
      store.applyMany([createEvent!, createMeeting!, createUserClass!, userExtendsMeeting!]);
      store.apply(meetingReissue!);
      expect(
        store.database
          .prepare(
            "SELECT parent_class_id FROM class_extends WHERE class_id = ? ORDER BY parent_class_id",
          )
          .all(userClassId),
      ).toEqual([{ parent_class_id: meetingId }]);
      expect(
        store.database
          .prepare(
            "SELECT parent_class_id FROM class_extends WHERE class_id = ? ORDER BY parent_class_id",
          )
          .all(meetingId),
      ).toEqual([{ parent_class_id: eventId }]);

      // Detaching meeting's seeded parent, adding an extra parent to meeting,
      // and adding a parent to event (no seeded parents — frozen to empty)
      // each fail loud and roll back.
      expect(() => store.apply(meetingDetach!)).toThrow(SystemExtendsLockError);
      expect(() => store.apply(meetingExtraParent!)).toThrow(SystemExtendsLockError);
      expect(() => store.apply(eventGainsParent!)).toThrow(SystemExtendsLockError);

      // The rejected writes left the derived closure exactly at the prefix state.
      expect(
        store.database
          .prepare(
            "SELECT parent_class_id FROM class_extends WHERE class_id = ? ORDER BY parent_class_id",
          )
          .all(eventId),
      ).toEqual([]);
      expect(
        (store.database.prepare("SELECT COUNT(*) AS n FROM class_extends").get() as { n: number }).n,
      ).toBe(2);
    });

    it("is-embedded-parent-page fixture throws the parent-page guard on apply", () => {
      const [pageP, blockB, violatingX] = loadFixture("is-embedded-parent-page.json");
      const p = "0192a000-0000-7000-8000-0000000000f1";
      const b = "0192a000-0000-7000-8000-0000000000f2";
      const x = "0192a000-0000-7000-8000-0000000000f3";
      const store = makeStore();
      // The prefix applies cleanly: page P, then embedded block B under P.
      store.applyMany([pageP!, blockB!]);
      expect(store.getNode(b)).toMatchObject({ parent_id: p, is_embedded: 1 });

      // Claiming the standalone role under the BLOCK fails loud (parent-page
      // condition, owner ruling 2026-10-15) and rolls back: no row for X.
      expect(() => store.apply(violatingX!)).toThrow(MoveGuardError);
      expect(store.getNode(x)).toBeUndefined();
    });

    it("object-is-embedded fixture: defaults, explicit claims, and the promotion/demotion toggle", () => {
      const [pageP, blockB, standaloneS, promoteB, demoteS, demoteB] = loadFixture(
        "object-is-embedded.json",
      );
      const p = "0192a000-0000-7000-8000-000000000af1";
      const b = "0192a000-0000-7000-8000-000000000af2";
      const s = "0192a000-0000-7000-8000-000000000af3";
      const store = makeStore();
      // Defaults: parentless P stores 0 (standalone by definition), parented
      // B stores 1 (embedded is the default); S's explicit standalone claim
      // stores 0.
      store.applyMany([pageP!, blockB!, standaloneS!]);
      expect(store.getNode(p)).toMatchObject({ parent_id: null, is_embedded: 0 });
      expect(store.getNode(b)).toMatchObject({ parent_id: p, is_embedded: 1 });
      expect(store.getNode(s)).toMatchObject({ parent_id: p, is_embedded: 0 });

      // The toggle: B promotes (1 -> 0), S demotes (0 -> 1), B demotes back.
      store.applyMany([promoteB!, demoteS!, demoteB!]);
      expect(store.getNode(b)?.is_embedded).toBe(1);
      expect(store.getNode(s)?.is_embedded).toBe(1);
    });

    it("an explicit isEmbedded: true claim is legal under any parent (only standalone claims are guarded)", () => {
      const store = makeStore();
      const PAGE = "0192a000-0000-7000-8000-0000000005e1";
      const BLOCK = "0192a000-0000-7000-8000-0000000005e2";
      const UNDER_PAGE = "0192a000-0000-7000-8000-0000000005e3";
      const UNDER_BLOCK = "0192a000-0000-7000-8000-0000000005e4";
      store.applyMany([
        createPage(PAGE, 1727200006000),
        env("object.create", { objectId: BLOCK, parentId: PAGE }, 1727200006100),
        env(
          "object.create",
          { objectId: UNDER_PAGE, parentId: PAGE, isEmbedded: true },
          1727200006200,
        ),
        env(
          "object.create",
          { objectId: UNDER_BLOCK, parentId: BLOCK, isEmbedded: true },
          1727200006300,
        ),
      ]);
      expect(store.getNode(UNDER_PAGE)?.is_embedded).toBe(1);
      expect(store.getNode(UNDER_BLOCK)?.is_embedded).toBe(1);
    });

    describe("parent-page condition (owner ruling 2026-10-15)", () => {
      const PAGE = "0192a000-0000-7000-8000-000000000501";
      const CHILD_PAGE = "0192a000-0000-7000-8000-000000000502";
      const BLOCK = "0192a000-0000-7000-8000-000000000503";
      const NESTED_BLOCK = "0192a000-0000-7000-8000-000000000504";
      const CLASS = "00000000-0000-7000-8000-000000000005";

      /** PAGE > (CHILD_PAGE | BLOCK > NESTED_BLOCK). */
      function treeStore(): Store {
        const store = makeStore();
        store.applyMany([
          createPage(PAGE, 1727200005000),
          env("object.create", { objectId: CHILD_PAGE, parentId: PAGE, isEmbedded: false }, 1727200005100),
          env("object.create", { objectId: BLOCK, parentId: PAGE }, 1727200005200),
          env("object.create", { objectId: NESTED_BLOCK, parentId: BLOCK }, 1727200005300),
        ]);
        return store;
      }

      it("nested page chain under a page applies; the bit under a block parent throws", () => {
        const store = treeStore();
        expect(store.getNode(CHILD_PAGE)).toMatchObject({ is_embedded: 0, parent_id: PAGE });
        // A page's standalone child may itself carry standalone children.
        store.apply(
          env(
            "object.create",
            { objectId: "0192a000-0000-7000-8000-000000000505", parentId: CHILD_PAGE, isEmbedded: false },
            1727200005400,
          ),
        );
        // ...but a block's child may not claim the bit.
        expect(() =>
          store.apply(
            env(
              "object.create",
              { objectId: "0192a000-0000-7000-8000-000000000506", parentId: BLOCK, isEmbedded: false },
              1727200005500,
            ),
          ),
        ).toThrow(MoveGuardError);
      });

      it("object.create with the bit under a class parent throws (a class is not a page)", () => {
        const store = makeStore();
        store.apply(env("class.create", { classId: CLASS, contentAst: [{ type: "text", text: "C" }] }, 1727200005000));
        expect(() =>
          store.apply(
            env(
              "object.create",
              { objectId: "0192a000-0000-7000-8000-000000000507", parentId: CLASS, isEmbedded: false },
              1727200005100,
            ),
          ),
        ).toThrow(MoveGuardError);
      });

      it("promotion fails loud under a block/class parent and applies under a page", () => {
        const store = treeStore();
        // NESTED_BLOCK's parent is a block: promotion rejected.
        expect(() =>
          store.apply(env("object.update", { objectId: NESTED_BLOCK, isEmbedded: false }, 1727200005600)),
        ).toThrow(MoveGuardError);
        // BLOCK's parent is PAGE: promotion applies (and stringifies content).
        store.apply(env("object.update", { objectId: BLOCK, isEmbedded: false }, 1727200005700));
        expect(store.getNode(BLOCK)).toMatchObject({ is_embedded: 0 });
        // A parentless row: the bit is unread, promotion stays harmless.
        store.apply(env("object.update", { objectId: PAGE, isEmbedded: false }, 1727200005800));
      });

      it("demotion fails loud while standalone children remain; applies once they are demoted", () => {
        const store = treeStore();
        // GRANDCHILD is a main child of the parented page CHILD_PAGE:
        // demoting CHILD_PAGE would dangle it. (A PARENTLESS page demotes
        // freely — it keeps document chrome by the second cascade branch,
        // so its standalone children stay valid.)
        store.apply(
          env(
            "object.create",
            { objectId: "0192a000-0000-7000-8000-000000000508", parentId: CHILD_PAGE, isEmbedded: false },
            1727200005450,
          ),
        );
        expect(() =>
          store.apply(env("object.update", { objectId: CHILD_PAGE, isEmbedded: true }, 1727200005600)),
        ).toThrow(MoveGuardError);
        // Demote the main child first, then the demotion applies.
        store.apply(
          env("object.update", { objectId: "0192a000-0000-7000-8000-000000000508", isEmbedded: true }, 1727200005700),
        );
        store.apply(env("object.update", { objectId: CHILD_PAGE, isEmbedded: true }, 1727200005800));
        expect(store.getNode(CHILD_PAGE)).toMatchObject({ is_embedded: 1 });
      });

      it("moving a main node under a block/class throws; under a page applies", () => {
        const store = treeStore();
        expect(() =>
          store.apply(env("object.move", { objectId: CHILD_PAGE, parentId: BLOCK }, 1727200005600)),
        ).toThrow(MoveGuardError);
        store.apply(env("object.move", { objectId: CHILD_PAGE, parentId: PAGE, afterId: BLOCK }, 1727200005700));
        expect(store.getNode(CHILD_PAGE)).toMatchObject({ parent_id: PAGE, is_embedded: 0 });
        // Moving an embedded BLOCK anywhere stays legal — moves never write the flag.
        store.apply(env("object.move", { objectId: NESTED_BLOCK, parentId: PAGE }, 1727200005800));
        expect(store.getNode(NESTED_BLOCK)).toMatchObject({ parent_id: PAGE, is_embedded: 1 });
      });
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

    /**
     * Bind a schema to a class (active-only row — sequence retired 2026-10-21)
     * and set the schema's GLOBAL default (owner ruling 2026-10-20 — defaults
     * are schema-level, one per property; the last default write wins across
     * classes).
     */
    function bind(
      store: Store,
      classId: string,
      schemaId: string,
      defaultValue: string,
      physical: number,
    ): void {
      store.apply(env("class.property.set", { classId, propertySchemaId: schemaId }, physical));
      store.apply(env("propertySchema.update", { propertySchemaId: schemaId, defaultValue }, physical + 1));
    }

    it("class.property.set upserts the binding row; a patch keeps omitted fields and a stale set is dropped", () => {
      const store = makeStore();
      store.applyMany(loadFixture("class-property-defaults.json").slice(0, 5));
      const row = () =>
        store.database
          .prepare("SELECT * FROM class_property WHERE class_id = ? AND property_schema_id = ?")
          .get(TASK, PRIORITY) as Record<string, unknown>;
      const schemaDefault = () =>
        (
          store.database
            .prepare("SELECT default_value FROM property_schema WHERE id = ?")
            .get(PRIORITY) as { default_value: string | null }
        ).default_value;
      expect(row()).toMatchObject({ active: 1 });
      // The fixture's default rides the SCHEMA row now (the global-default move).
      expect(schemaDefault()).toBe('"medium"');

      // Patch only the active flag: the default survives on the schema row.
      store.apply(
        env("class.property.set", { classId: TASK, propertySchemaId: PRIORITY, active: false }, 1727200012000),
      );
      expect(row()).toMatchObject({ active: 0, hlc_physical: 1727200012000 });
      expect(schemaDefault()).toBe('"medium"');
      // Re-enable rides the same patch path.
      store.apply(
        env("class.property.set", { classId: TASK, propertySchemaId: PRIORITY, active: true }, 1727200012050),
      );
      expect(row()).toMatchObject({ active: 1, hlc_physical: 1727200012050 });

      // The schema default is keep/clear typed (PC2): an update patches it.
      store.apply(
        env("propertySchema.update", { propertySchemaId: PRIORITY, defaultValue: "low" }, 1727200012100),
      );
      expect(schemaDefault()).toBe('"low"');

      // A lower-HLC set is dropped by row LWW (state unchanged).
      const stale = store.apply(
        env("class.property.set", { classId: TASK, propertySchemaId: PRIORITY }, 1727200010500),
      );
      expect(stale.ignored).toBe(true);
      expect(row()).toMatchObject({ active: 1, hlc_physical: 1727200012050 });
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

    it("fixture: the schema default applies; it survives binding churn; no binding — no default", () => {
      const store = makeStore();
      const fixture = loadFixture("class-property-defaults.json");
      const priorityOf = () => store.getEffectiveProperties(ITEM);

      store.applyMany(fixture.slice(0, 5)); // schema (default 'medium'), classes, node (Task), Task binding
      expect(priorityOf()).toEqual([
        {
          propertySchemaId: PRIORITY,
          idx: 0,
          // PG5: derived default rows carry a deterministic synthetic element id.
          elementId: `default:${PRIORITY}:0`,
          schema: {
            id: PRIORITY,
            name: "priority",
            type: "select",
            multi: false,
            icon: null,
            scopeClassIds: null,
            validationRules: null,
            datePrecision: null,
            dateQualified: null,
            numberPad: null,
            numberDecimals: null,
            numberRounding: null,
            display: null,
            hideWhenEmpty: null,
          },
          value: "medium",
          metadata: null,
          source: "default",
          boundBy: TASK,
          hideWhenEmpty: null,
          display: null,
          eligible: true,
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
      // The default is the SCHEMA's single global value — Project's binding
      // adds presence (Task still wins boundBy, earliest assignment HLC), not
      // a competing default.
      expect(priorityOf()).toEqual([
        expect.objectContaining({ value: "medium", source: "default", boundBy: TASK }),
      ]);
      expect(
        JSON.parse(store.getNode(ITEM)?.class_ids ?? "[]").sort(),
      ).toEqual([TASK, PROJECT].sort());

      store.apply(fixture[7]!); // unset Task's binding — Project still binds: same global default
      expect(priorityOf()).toEqual([
        expect.objectContaining({ value: "medium", source: "default", boundBy: PROJECT }),
      ]);

      store.apply(fixture[8]!); // unset Project's binding too — no binding, no derived default
      expect(priorityOf()).toEqual([]);
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
        env("object.create", { objectId: node, classIds: [CLASS_X, CLASS_Y] }, 1727200011600),
      );

      const effective = store.getEffectiveProperties(node);
      expect(effective.map((row) => [row.schema?.name, row.value, row.boundBy])).toEqual([
        ["effort", "xs", CLASS_X],
        ["impact", "xl", CLASS_Y],
      ]);
    });

    it("binding-conflict resolution follows assignment HLC (earliest first), not class id or write order", () => {
      const store = makeStore();
      makeSchema(store, EFFORT, "effort", 1727200011000);
      makeClass(store, CLASS_X, "X", 1727200011100);
      makeClass(store, CLASS_Y, "Y", 1727200011200);
      // Write order is the reverse of assignment order; the DEFAULT is
      // schema-global (owner ruling 2026-10-20) — the last write ('x') wins
      // for every node, so the conflict these tests resolve is the WINNING
      // BINDING (boundBy), not the value.
      bind(store, CLASS_Y, EFFORT, "y", 1727200012500);
      bind(store, CLASS_X, EFFORT, "x", 1727200012600);

      // Node 1: X assigned first, Y later.
      const node1 = "0192a000-0000-7000-8000-0000000003c1";
      store.apply(env("object.create", { objectId: node1, classIds: [CLASS_X] }, 1727200011300));
      store.apply(env("object.create", { objectId: node1, classIds: [CLASS_Y] }, 1727200012000));

      // Node 2: Y assigned first, X later.
      const node2 = "0192a000-0000-7000-8000-0000000003c2";
      store.apply(env("object.create", { objectId: node2, classIds: [CLASS_Y] }, 1727200011400));
      store.apply(env("object.create", { objectId: node2, classIds: [CLASS_X] }, 1727200012100));

      expect(store.getEffectiveProperties(node1)).toEqual([
        expect.objectContaining({ value: "x", boundBy: CLASS_X }),
      ]);
      expect(store.getEffectiveProperties(node2)).toEqual([
        expect.objectContaining({ value: "x", boundBy: CLASS_Y }),
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
      store.apply(env("object.create", { objectId: node, classIds: [CLASS_Y, CLASS_X] }, 1727200011500));

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
      store.apply(env("object.create", { objectId: authoredNode, classIds: [CLASS_X] }, 1727200011300));
      store.apply(env("property.set", { objectId: authoredNode, propertySchemaId: EFFORT, value: "authored" }, 1727200011400));
      const derivedNode = "0192a000-0000-7000-8000-0000000003c2";
      store.apply(env("object.create", { objectId: derivedNode, classIds: [CLASS_X] }, 1727200011300));

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
      store.apply(env("object.create", { objectId: node, classIds: [CLASS_X] }, 1727200011300));
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
      store.apply(env("object.create", { objectId: node1 }, 1727200011300));
      store.apply(env("class.unassign", { objectId: node1, classId: CLASS_X }, 1727200011400));
      store.apply(env("object.create", { objectId: node1, classIds: [CLASS_X] }, 1727200011400));
      // Order 2: the add lands first, then the equal-HLC remove is dropped.
      const node2 = "0192a000-0000-7000-8000-0000000003c2";
      store.apply(env("object.create", { objectId: node2 }, 1727200011300));
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
      store.apply(env("object.create", { objectId: node, classIds: [CLASS_X] }, 1727200011300));
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
      expect(store.getNode(NODE_PAGE)).toMatchObject({ is_class: 0, is_embedded: 0 });
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

    it("beforeId places the node before the anchor, including before the first child", () => {
      const PB = "0192a000-0000-7000-8000-000000000140";
      const BA = "0192a000-0000-7000-8000-000000000141";
      const BB = "0192a000-0000-7000-8000-000000000142";
      const BC = "0192a000-0000-7000-8000-000000000143";
      const BD = "0192a000-0000-7000-8000-000000000144";
      const store = makeStore();
      store.applyMany(loadFixture("object-move-before.json"));
      expect(store.children(PB).map((n) => n.id)).toEqual([BB, BC, BD, BA]);
      // Exactly one child_order row per node — no dual-parent residue.
      for (const child of [BA, BB, BC, BD]) {
        expect(
          (
            store.database
              .prepare("SELECT COUNT(*) AS n FROM node_child_order WHERE child_id = ?")
              .get(child) as { n: number }
          ).n,
        ).toBe(1);
      }
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

    it("root move of a parented inline node is legal, drops its child_order row and leaves the bit untouched", () => {
      const store = baseStore();
      const block = "0192a000-0000-7000-8000-0000000000e1";
      store.apply(env("object.create", { objectId: block, parentId: NODE_PAGE }, 1727200002000));
      store.apply(env("object.move", { objectId: block, parentId: null }, 1727200002100));
      expect(store.getNode(block)?.parent_id).toBeNull();
      // Moves never write the render bit: still 0 — and unread anyway,
      // because parentless nodes render with document chrome.
      expect(store.getNode(block)?.is_embedded).toBe(1);
      expect(
        (
          store.database
            .prepare("SELECT COUNT(*) AS n FROM node_child_order WHERE child_id = ?")
            .get(block) as { n: number }
        ).n,
      ).toBe(0);
    });

    it("root move of a main child is legal and drops its child_order row", () => {
      const store = baseStore();
      const sub = "0192a000-0000-7000-8000-0000000000e1";
      store.apply(
        env("object.create", { objectId: sub, parentId: NODE_PAGE, isEmbedded: false }, 1727200002000),
      );
      store.apply(env("object.move", { objectId: sub, parentId: null }, 1727200002100));
      expect(store.getNode(sub)?.parent_id).toBeNull();
      expect(store.getNode(sub)?.is_embedded).toBe(0);
      expect(
        (
          store.database
            .prepare("SELECT COUNT(*) AS n FROM node_child_order WHERE child_id = ?")
            .get(sub) as { n: number }
        ).n,
      ).toBe(0);
    });

    it("allows moving a non-class node under a class (classes are containers, spec I4)", () => {
      const store = baseStore();
      const classId = "c0000000-0000-7000-8000-0000000000c1";
      const block = "0192a000-0000-7000-8000-0000000000e1";
      store.apply(env("class.create", { classId, contentAst: [{ type: "text", text: "Tag" }]}, 1727200001500));
      store.apply(env("object.create", { objectId: block, parentId: NODE_PAGE }, 1727200002000));
      store.apply(env("object.move", { objectId: block, parentId: classId }, 1727200002100));
      expect(store.getNode(block)?.parent_id).toBe(classId);
      expect(store.children(classId).map((n) => n.id)).toEqual([block]);
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

  describe("roots (workspace top-level pages)", () => {
    it("lists active parentless non-class rows in id order, excluding classes, parented nodes, and other workspaces", () => {
      const store = makeStore();
      // Creation order deliberately differs from id order: the node name
      // cache stays null under title-is-content, so the display ORDER BY
      // COALESCE(name, id), id reads as a deterministic id sort.
      store.apply(
        env("object.create", { objectId: NODE_BOOK, contentAst: [{ type: "text", text: "Alpha" }] }, 1727200001000),
      );
      store.apply(
        env("object.create", { objectId: NODE_PAGE, contentAst: [{ type: "text", text: "Zeta" }] }, 1727200002000),
      );
      // A class is parentless by law but never a root page.
      store.apply(
        env("class.create", { classId: "c0000000-0000-7000-8000-0000000000c1", contentAst: [{ type: "text", text: "Genre" }] }, 1727200003000),
      );
      // Parented nodes stay out regardless of the render bit: a main child...
      const sub = "0192a000-0000-7000-8000-0000000000d1";
      store.apply(
        env("object.create", { objectId: sub, parentId: NODE_PAGE, isEmbedded: false, contentAst: [{ type: "text", text: "Sub" }] }, 1727200004000),
      );
      // ...and an inline block.
      store.apply(
        env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000d2", parentId: NODE_PAGE, contentAst: [{ type: "text", text: "inline" }] }, 1727200005000),
      );
      // A page in ANOTHER workspace must not leak into this workspace's roots.
      const otherWs = "0192a000-0000-7000-8000-000000000009";
      store.apply(
        newEnvelope({
          workspaceId: otherWs,
          actorId: ACTOR,
          deviceId: "test-device-store",
          hlc: { physical: 1727200006000, logical: 0 },
          opType: "object.create",
          payload: { objectId: "0192a000-0000-7000-8000-0000000000e9" },
          timestamp: new Date(1727200006000).toISOString(),
        }),
      );

      expect(store.roots(WS).map((row) => row.id)).toEqual([NODE_PAGE, NODE_BOOK]);
      expect(store.roots(otherWs).map((row) => row.id)).toEqual([
        "0192a000-0000-7000-8000-0000000000e9",
      ]);

      // Soft delete drops the root (and its subtree) from the read.
      store.apply(env("object.delete", { objectId: NODE_PAGE }, 1727200007000));
      expect(store.roots(WS).map((row) => row.id)).toEqual([NODE_BOOK]);
    });
  });

  describe("property schema number formats", () => {
    it("create carries the format; update keeps absent, clears null", () => {
      const store = baseStore();
      const id = "0192a000-0000-7000-8000-0000000000f8";
      store.apply(
        env(
          "propertySchema.create",
          {
            propertySchemaId: id,
            name: "fmt",
            type: "number",
            numberPad: 4,
            numberDecimals: 1,
            numberRounding: "floor",
          },
          1727200002000,
        ),
      );
      const row = () =>
        store.database
          .prepare("SELECT number_pad, number_decimals, number_rounding FROM property_schema WHERE id = ?")
          .get(id) as { number_pad: number | null; number_decimals: number | null; number_rounding: string | null };
      expect(row()).toEqual({ number_pad: 4, number_decimals: 1, number_rounding: "floor" });
      // Absent keeps; null clears (the keep-vs-clear contract).
      store.apply(env("propertySchema.update", { propertySchemaId: id, name: "fmt2" }, 1727200002100));
      expect(row()).toEqual({ number_pad: 4, number_decimals: 1, number_rounding: "floor" });
      store.apply(
        env("propertySchema.update", { propertySchemaId: id, numberDecimals: null, numberRounding: null }, 1727200002200),
      );
      expect(row()).toEqual({ number_pad: 4, number_decimals: null, number_rounding: null });
    });
  });

  describe("object.restore", () => {
    const child = "0192a000-0000-7000-8000-0000000000d1";
    const grandchild = "0192a000-0000-7000-8000-0000000000d2";
    const sibling = "0192a000-0000-7000-8000-0000000000d3";

    const family = (store: Store) => {
      store.apply(
        env(
          "object.create",
          { objectId: child, parentId: NODE_PAGE, contentAst: [{ type: "text", text: "child block" }] },
          1727200002000,
        ),
      );
      store.apply(
        env(
          "object.create",
          { objectId: grandchild, parentId: child, contentAst: [{ type: "text", text: "grandchild" }] },
          1727200002100,
        ),
      );
      store.apply(
        env(
          "object.create",
          { objectId: sibling, parentId: NODE_PAGE, contentAst: [{ type: "text", text: "sibling" }] },
          1727200002200,
        ),
      );
    };

    it("restores the whole subtree trashed with the node and consumes the trash row", () => {
      const store = baseStore();
      family(store);
      store.apply(env("object.delete", { objectId: NODE_PAGE }, 1727200003000));
      expect(store.getNode(grandchild)?.is_active).toBe(0);

      store.apply(env("object.restore", { objectId: NODE_PAGE }, 1727200003100));
      expect(store.getNode(NODE_PAGE)?.is_active).toBe(1);
      expect(store.getNode(child)?.is_active).toBe(1);
      expect(store.getNode(grandchild)?.is_active).toBe(1);
      expect(store.getNode(sibling)?.is_active).toBe(1);
      expect(
        store.database.prepare("SELECT 1 FROM trash WHERE node_id = ?").get(NODE_PAGE),
      ).toBeUndefined();
      // Tree placement survived the trash round-trip.
      expect(store.children(NODE_PAGE).map((n) => n.id)).toEqual([child, sibling]);
    });

    it("a descendant trashed independently (own trash row) stays trashed on the parent's restore", () => {
      const store = baseStore();
      family(store);
      // The child is trashed on its own first; the parent follows.
      store.apply(env("object.delete", { objectId: child }, 1727200002900));
      store.apply(env("object.delete", { objectId: NODE_PAGE }, 1727200003000));

      store.apply(env("object.restore", { objectId: NODE_PAGE }, 1727200003100));
      expect(store.getNode(NODE_PAGE)?.is_active).toBe(1);
      expect(store.getNode(sibling)?.is_active).toBe(1);
      expect(store.getNode(child)?.is_active).toBe(0);
      expect(store.getNode(grandchild)?.is_active).toBe(0);
      // Its own trash row survives — a later child restore still works.
      expect(
        store.database.prepare("SELECT 1 FROM trash WHERE node_id = ?").get(child),
      ).toBeDefined();
      store.apply(env("object.restore", { objectId: child }, 1727200003200));
      expect(store.getNode(child)?.is_active).toBe(1);
      expect(store.getNode(grandchild)?.is_active).toBe(1);
    });

    it("dangling parent (parent row gone) reparents to the workspace root", () => {
      const store = baseStore();
      family(store);
      // Trash the grandchild normally (its parent exists at that point).
      store.apply(env("object.delete", { objectId: grandchild }, 1727200002900));
      // Legacy corner: the parent's row disappears after the trash (imported
      // data pruned without FK enforcement) while the trashed node survives
      // with a dangling parent_id. FKs are per-connection in SQLite — the
      // derived schema enforces parent_id, so the toggle simulates the state;
      // sql.js compiles without enforcement (same simulation for free).
      store.database.pragma("foreign_keys = OFF");
      store.database
        .prepare("DELETE FROM node_child_order WHERE parent_id = ? OR child_id = ?")
        .run(child, child);
      store.database.prepare("DELETE FROM trash WHERE node_id = ?").run(child);
      store.database.prepare("DELETE FROM node WHERE id = ?").run(child);
      store.database.pragma("foreign_keys = ON");

      store.apply(env("object.restore", { objectId: grandchild }, 1727200003100));
      const row = store.getNode(grandchild);
      expect(row?.is_active).toBe(1);
      expect(row?.parent_id).toBeNull();
      expect(store.roots(WS).map((r) => r.id)).toContain(grandchild);
    });

    it("restoring a permanently deleted node fails loud (not_found)", () => {
      const store = baseStore();
      store.apply(env("object.delete", { objectId: NODE_PAGE, permanent: true }, 1727200003000));
      expect(() => store.apply(env("object.restore", { objectId: NODE_PAGE }, 1727200003100))).toThrow(
        /does not exist/,
      );
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

    describe("permanent delete heals node_stats (the badge counts live edges only)", () => {
      const SOURCE_PAGE = "0192a000-0000-7000-8000-0000000000e1";
      const SOURCE_BLOCK = "0192a000-0000-7000-8000-0000000000e2";
      const GRANDCHILD = "0192a000-0000-7000-8000-0000000000e3";

      const mentionToken = (target: string, text: string) => ({
        type: "mention",
        targetNodeId: target,
        text,
      });
      const statsOf = (store: Store, id: string) =>
        (
          store.database
            .prepare("SELECT backlink_count AS n FROM node_stats WHERE node_id = ?")
            .get(id) as { n: number } | undefined
        )?.n ?? 0;
      const descendantsOf = (store: Store, id: string) =>
        (
          store.database
            .prepare("SELECT descendant_count AS n FROM node_stats WHERE node_id = ?")
            .get(id) as { n: number } | undefined
        )?.n ?? 0;

      /** NODE_BOOK's block mentions NODE_PAGE: the badge contract setup. */
      function linkedStore(): Store {
        const store = baseStore();
        store.apply(env("object.create", { objectId: SOURCE_PAGE }, 1727200001500));
        store.apply(
          env(
            "object.create",
            {
              objectId: SOURCE_BLOCK,
              parentId: SOURCE_PAGE,
              contentAst: [mentionToken(NODE_PAGE, "page")],
            },
            1727200001600,
          ),
        );
        return store;
      }

      it("object.delete {permanent: true} rebuilds the backlink targets' badge counts", () => {
        const store = linkedStore();
        expect(statsOf(store, NODE_PAGE)).toBe(1);
        store.apply(env("object.delete", { objectId: SOURCE_PAGE, permanent: true }, 1727200002000));
        expect(store.backlinks(NODE_PAGE)).toEqual([]);
        // The badge reads node_stats (a stored number) — it must not
        // outlive the edges it counts.
        expect(statsOf(store, NODE_PAGE)).toBe(0);
      });

      it("trash.empty rebuilds the backlink targets' badge counts", () => {
        const store = linkedStore();
        store.apply(env("object.delete", { objectId: SOURCE_PAGE }, 1727200002000));
        expect(statsOf(store, NODE_PAGE)).toBe(1);
        store.apply(env("trash.empty", {}, 1727200003000));
        expect(store.backlinks(NODE_PAGE)).toEqual([]);
        expect(statsOf(store, NODE_PAGE)).toBe(0);
      });

      it("the subtree's ancestors' descendant counts are rebuilt too", () => {
        const store = baseStoreWithBlock(); // NODE_BLOCK under NODE_PAGE
        store.apply(env("object.create", { objectId: GRANDCHILD, parentId: NODE_BLOCK }, 1727200001500));
        expect(descendantsOf(store, NODE_PAGE)).toBe(2);
        store.apply(env("object.delete", { objectId: NODE_BLOCK, permanent: true }, 1727200002000));
        expect(descendantsOf(store, NODE_PAGE)).toBe(0);
      });

      it("rebuildEdges on a gone source heals its orphaned backlink targets", () => {
        const store = linkedStore();
        // Simulate the source row disappearing without the delete applier —
        // the gone-branch contract: the edge outlives the node until the
        // rebuild sweeps it.
        store.database.prepare("DELETE FROM node_child_order WHERE child_id = ?").run(SOURCE_BLOCK);
        store.database.prepare("DELETE FROM node WHERE id = ?").run(SOURCE_BLOCK);
        rebuildEdges(store.database, SOURCE_BLOCK, new Date(1727200002000).toISOString());
        expect(store.backlinks(NODE_PAGE)).toEqual([]);
        expect(statsOf(store, NODE_PAGE)).toBe(0);
      });
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

    it("promotes an inline child to the main-children zone and demotes it back (the isEmbedded toggle)", () => {
      const store = makeStore();
      const parent = "0192a000-0000-7000-8000-0000000000f0";
      store.apply(createPage(parent, 1727200000000));
      const child = "0192a000-0000-7000-8000-0000000000f1";
      // No payload isEmbedded: a parented create defaults to the inline
      // body (bit 0) and keeps rich content.
      store.apply(
        env(
          "object.create",
          {
            objectId: child,
            parentId: parent,
            contentAst: [
              { type: "text", text: "rich " },
              { type: "mention", targetNodeId: NODE_BOOK, text: "book" },
            ],
          },
          1727200001000,
        ),
      );
      expect(store.getNode(child)).toMatchObject({ is_class: 0, is_embedded: 1 });
      expect(JSON.parse(store.getNode(child)?.content ?? "[]")).toHaveLength(2);

      // Promotion (0 → 1) flattens the rich token stream in the same op.
      store.apply(env("object.update", { objectId: child, isEmbedded: false }, 1727200002000));
      expect(store.getNode(child)?.is_embedded).toBe(0);
      expect(JSON.parse(store.getNode(child)?.content ?? "[]")).toEqual([
        { type: "text", text: "rich book" },
      ]);

      // Demotion (1 → 0) is legal because the node has a parent — and does
      // NOT un-flatten the content.
      store.apply(env("object.update", { objectId: child, isEmbedded: true }, 1727200003000));
      expect(store.getNode(child)?.is_embedded).toBe(1);
      expect(JSON.parse(store.getNode(child)?.content ?? "[]")).toEqual([
        { type: "text", text: "rich book" },
      ]);
    });

    it("a main child created with isEmbedded:true starts flattened", () => {
      const store = makeStore();
      const parent = "0192a000-0000-7000-8000-0000000000f0";
      store.apply(createPage(parent, 1727200000000));
      const child = "0192a000-0000-7000-8000-0000000000f1";
      store.apply(
        env(
          "object.create",
          {
            objectId: child,
            parentId: parent,
            isEmbedded: false,
            contentAst: [
              { type: "text", text: "title " },
              { type: "mention", targetNodeId: NODE_BOOK, text: "book" },
            ],
          },
          1727200001000,
        ),
      );
      expect(store.getNode(child)?.is_embedded).toBe(0);
      expect(JSON.parse(store.getNode(child)?.content ?? "[]")).toEqual([
        { type: "text", text: "title book" },
      ]);
    });

    it("demoting a parentless node clears the bit without un-flattening (bit unread there)", () => {
      const store = baseStore();
      // NODE_PAGE is parentless with is_embedded = 0 and flattened text
      // content; flipping the bit off is legal — the placement CHECK only
      // pins classes to roots — and the parentless row still renders with
      // document chrome by the second cascade branch.
      store.apply(env("object.update", { objectId: NODE_PAGE, isEmbedded: true }, 1727200002000));
      expect(store.getNode(NODE_PAGE)?.is_embedded).toBe(1);
      expect(store.getNode(NODE_PAGE)?.parent_id).toBeNull();
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

    it("multi-term queries rank whole-query matches first and partial matches last", () => {
      const store = baseStoreWithBlock();
      store.applyMany(loadFixture("typed-link-mark.json"));
      // "Kuhn Scient" — the block carrying both terms still wins…
      expect(store.search("Kuhn Scient")).toEqual([{ nodeId: NODE_BLOCK }]);
      // …but "Kuhn absentterm" no longer returns nothing: the partial match
      // (Kuhn only) enters the list as a lower tier (priority ranking,
      // owner 2026-10-13). Quoted phrases stay strict AND.
      expect(store.search("Kuhn absentterm")).toEqual([{ nodeId: NODE_BLOCK }]);
      expect(store.search('"Kuhn absentterm"')).toEqual([]);
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
      store.apply(env("object.create", { objectId: id, contentAst: [{ type: "text", text: "Alpha" }]}, 1727200002000));
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
      const a = env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000e1", contentAst: [{ type: "text", text: "A" }]}, 1727200002000);
      const b = env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000e2", contentAst: [{ type: "text", text: "B" }]}, 1727200003000);
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

  describe("backlinksWithRollup (source-side containment roll-up)", () => {
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
      store.apply(env("object.create", { objectId: FRANCE, contentAst: [{ type: "text", text: "France" }]}, 1727200001000));
      store.apply(env("object.create", { objectId: PARIS, contentAst: [{ type: "text", text: "Paris" }]}, 1727200001100));
      store.apply(env("object.create", { objectId: SPAIN, contentAst: [{ type: "text", text: "Spain" }]}, 1727200001200));
      store.apply(env("object.create", { objectId: NOTES, contentAst: [{ type: "text", text: "Notes" }]}, 1727200001300));
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

  describe("referencesWithRollup (outgoing source-side roll-up, the References tab)", () => {
    const FRANCE = "0192a000-0000-7000-8000-0000000000e2";
    const PARIS = "0192a000-0000-7000-8000-0000000000e3";
    const LONDON = "0192a000-0000-7000-8000-0000000000e6";
    const BERLIN = "0192a000-0000-7000-8000-0000000000e7";
    const PROP_REF = "0192a000-0000-7000-8000-0000000000a9";

    interface RefRow {
      source_id: string;
      target_id: string;
      type: string;
      verb: string | null;
      kind: string;
      distance: number;
    }

    /** France, Paris, London, Berlin as separate roots (Paris/Spain/Notes unused here). */
    function travelStore(): Store {
      const store = makeStore();
      store.apply(env("object.create", { objectId: FRANCE, contentAst: [{ type: "text", text: "France" }] }, 1727200001000));
      store.apply(env("object.create", { objectId: PARIS, contentAst: [{ type: "text", text: "Paris" }] }, 1727200001100));
      store.apply(env("object.create", { objectId: LONDON, contentAst: [{ type: "text", text: "London" }] }, 1727200001200));
      store.apply(env("object.create", { objectId: BERLIN, contentAst: [{ type: "text", text: "Berlin" }] }, 1727200001300));
      return store;
    }

    function mention(target: string, text: string) {
      return { type: "mention", targetNodeId: target, text };
    }

    const rowsOf = (store: Store, id: string) =>
      (store.referencesWithRollup(id) as RefRow[]).map((r) => ({
        source: r.source_id,
        target: r.target_id,
        type: r.type,
        verb: r.verb,
        kind: r.kind,
        distance: r.distance,
      }));

    it("one row per target: direct (own property ref) first, containment (blocks under the page) by depth", () => {
      const store = travelStore();
      // France's own node-typed property value → a DIRECT row.
      store.apply(
        env("property.set", { objectId: FRANCE, propertySchemaId: PROP_REF, value: { nodeId: PARIS }, idx: 0 }, 1727200002000),
      );
      // Blocks under France link London (twice — one row) and Berlin (nested deeper).
      const b = "0192a000-0000-7000-8000-0000000000f1";
      store.apply(
        env("object.create", { objectId: b, parentId: FRANCE, contentAst: [mention(LONDON, "London"), mention(LONDON, "London")] }, 1727200002100),
      );
      const b4 = "0192a000-0000-7000-8000-0000000000f2";
      store.apply(
        env("object.create", { objectId: b4, parentId: b, contentAst: [mention(BERLIN, "Berlin")] }, 1727200002200),
      );

      expect(rowsOf(store, FRANCE)).toEqual([
        { source: FRANCE, target: PARIS, type: "property", verb: PROP_REF, kind: "direct", distance: 0 },
        { source: b, target: LONDON, type: "mention", verb: null, kind: "containment", distance: 1 },
        { source: b4, target: BERLIN, type: "mention", verb: null, kind: "containment", distance: 2 },
      ]);
      // The mirror holds: Paris/London/Berlin list the SAME edges as backlinks.
      expect((store.backlinksWithRollup(PARIS) as Array<{ source_id: string; kind: string }>).map((r) => ({ source: r.source_id, kind: r.kind }))).toEqual([
        { source: FRANCE, kind: "direct" },
      ]);
    });

    it("many edges to one target collapse to the most direct occurrence", () => {
      const store = travelStore();
      // France's own property ref beats a block's mention of the same target.
      store.apply(
        env("property.set", { objectId: FRANCE, propertySchemaId: PROP_REF, value: { nodeId: PARIS }, idx: 0 }, 1727200002000),
      );
      const b = "0192a000-0000-7000-8000-0000000000f1";
      store.apply(
        env("object.create", { objectId: b, parentId: FRANCE, contentAst: [mention(PARIS, "Paris"), mention(PARIS, "Paris")] }, 1727200002100),
      );
      expect(rowsOf(store, FRANCE)).toEqual([
        { source: FRANCE, target: PARIS, type: "property", verb: PROP_REF, kind: "direct", distance: 0 },
      ]);
    });

    it("document-chrome target filter: top-level pages and the page's own child pages in; classes, inline blocks, deeper-nested pages and targetless typed links out", () => {
      const store = travelStore();
      const cls = "c0000000-0000-7000-8000-0000000000c1";
      store.apply(env("class.create", { classId: cls, contentAst: [{ type: "text", text: "Tag" }] }, 1727200001400));
      // France's own child pages: KID (direct child, renders with document
      // chrome) and GK (KID's child — nested under another page, not France).
      const kid = "0192a000-0000-7000-8000-0000000000e8";
      store.apply(env("object.create", { objectId: kid, parentId: FRANCE, isEmbedded: false, contentAst: [{ type: "text", text: "Kid" }] }, 1727200001500));
      const gk = "0192a000-0000-7000-8000-0000000000e9";
      store.apply(env("object.create", { objectId: gk, parentId: kid, isEmbedded: false, contentAst: [{ type: "text", text: "Grandkid" }] }, 1727200001600));
      // An inline block under France — never document chrome.
      const inline = "0192a000-0000-7000-8000-0000000000fa";
      store.apply(env("object.create", { objectId: inline, parentId: FRANCE, contentAst: [{ type: "text", text: "inline" }] }, 1727200001700));

      const b = "0192a000-0000-7000-8000-0000000000f1";
      store.apply(
        env("object.create", {
          objectId: b,
          parentId: FRANCE,
          contentAst: [
            mention(PARIS, "Paris"),
            mention(cls, "Tag"),
            mention(kid, "Kid"),
            mention(gk, "Grandkid"),
            mention(inline, "inline"),
            { type: "typed_link", text: "supports" },
          ],
        }, 1727200002000),
      );

      expect(rowsOf(store, FRANCE).map((r) => r.target)).toEqual([PARIS, kid]);
      // The typed_link edge EXISTS in the raw read (targetless by design) but
      // never matches the rollup's target-set filter.
      const rawTypes = (store.references(b) as Array<{ type: string; target_id: string | null }>).map((r) => r.type).sort();
      expect(rawTypes).toEqual(["mention", "mention", "mention", "mention", "mention", "typed_link"]);
      expect((store.references(b) as Array<{ type: string; target_id: string | null }>).find((r) => r.type === "typed_link")?.target_id).toBeNull();
    });

    it("trashed targets and trashed sources stay out", () => {
      const store = travelStore();
      const b = "0192a000-0000-7000-8000-0000000000f1";
      store.apply(
        env("object.create", { objectId: b, parentId: FRANCE, contentAst: [mention(PARIS, "Paris")] }, 1727200002000),
      );
      expect(rowsOf(store, FRANCE).map((r) => r.target)).toEqual([PARIS]);

      // Trash the target: the edge row survives (PB1) but the target filter drops it.
      store.apply(env("object.delete", { objectId: PARIS }, 1727200003000));
      expect(rowsOf(store, FRANCE)).toEqual([]);

      // Restore the target, trash the SOURCE block: a trashed node no longer
      // claims a reference.
      store.apply(env("object.restore", { objectId: PARIS }, 1727200003100));
      store.apply(env("object.delete", { objectId: b }, 1727200003200));
      expect(rowsOf(store, FRANCE)).toEqual([]);
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
    expect(restored.getNode(NODE_PAGE)).toMatchObject({ is_class: 0, is_embedded: 0 });

    restored.close();
    source.close();
  });
});

describe("aliasNodesOf (the reverse alias read behind the backlinks roll-up)", () => {
  const MAIN = "0192a000-0000-7000-8000-0000000000f1";
  const ALIAS = "0192a000-0000-7000-8000-0000000000f2";
  const CHAIN = "0192a000-0000-7000-8000-0000000000f3";
  const OTHER = "0192a000-0000-7000-8000-0000000000f4";

  const alias = (from: string, to: string | null, physical: number) =>
    env("object.update", { objectId: from, aliasedNodeId: to }, physical);

  it("lists every node whose alias-terminal is the main, chains included; [] when none", () => {
    const store = Store.open(betterSqlite3Backend(":memory:"));
    for (const id of [MAIN, ALIAS, CHAIN, OTHER]) store.apply(createPage(id, 1727200000000));
    expect(store.aliasNodesOf(MAIN)).toEqual([]);
    // A plain alias and a chain member both resolve to the main.
    store.apply(alias(ALIAS, MAIN, 1727200001000));
    store.apply(alias(CHAIN, ALIAS, 1727200002000));
    expect(store.aliasNodesOf(MAIN)).toEqual([ALIAS, CHAIN]);
    // CHAIN points at ALIAS directly, so it lists under ALIAS's own set…
    expect(store.aliasNodesOf(ALIAS)).toEqual([CHAIN]);
    // …while nothing points at CHAIN or OTHER.
    expect(store.aliasNodesOf(CHAIN)).toEqual([]);
    expect(store.aliasNodesOf(OTHER)).toEqual([]);
    store.close();
  });

  it("never includes the main itself and skips trashed aliases", () => {
    const store = Store.open(betterSqlite3Backend(":memory:"));
    for (const id of [MAIN, ALIAS, OTHER]) store.apply(createPage(id, 1727200000000));
    store.apply(alias(ALIAS, MAIN, 1727200001000));
    expect(store.aliasNodesOf(MAIN)).toEqual([ALIAS]);
    // Trash the alias (soft-delete keeps the row, flips is_active).
    store.apply(env("object.delete", { objectId: ALIAS }, 1727200002000));
    expect(store.aliasNodesOf(MAIN)).toEqual([]);
    // The trash never lists as a terminal either.
    expect(store.aliasNodesOf(ALIAS)).toEqual([]);
    expect(store.aliasNodesOf(OTHER)).toEqual([]);
    store.close();
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
        { objectId: MIGRATED_PAGE, contentAst: [{ type: "text", text: "20180900 daily note" }] },
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
      documents: (
        store.database
          .prepare(
            "SELECT COUNT(*) AS n FROM node WHERE is_class = 0 AND (parent_id IS NULL OR is_embedded = 0) AND is_active=1",
          )
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
        { objectId: MIGRATED_PAGE, contentAst: [{ type: "text", text: "clasificaciones taxonomy" }] },
        1727200002000,
      ),
    );
    expect(client.search("clasificaciones").map((h) => h.nodeId)).toContain(MIGRATED_PAGE);
    // Node data itself is untouched by the rebuild.
    expect(client.getNode(MIGRATED_PAGE)).toMatchObject({ is_class: 0, is_embedded: 0 });
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
        { objectId: MIGRATED_PAGE, contentAst: [{ type: "text", text: "20180900 daily note" }] },
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
        { objectId: MIGRATED_PAGE, contentAst: [{ type: "text", text: "sqlite cross-backend" }] },
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
  describe(`object.update active (archival) on ${adapter.name}`, () => {
    it("archives then unarchives a page: is_active flips, NO trash row ever", () => {
      const store = Store.open(adapter.makeBackend());
      const page = "0192a000-0000-7000-8000-000000000511";
      const other = "0192a000-0000-7000-8000-000000000512";
      store.apply(env("object.create", { objectId: page, contentAst: [{ type: "text", text: "P" }] }, 1727200001000));
      store.apply(env("object.create", { objectId: other, contentAst: [{ type: "text", text: "Q" }] }, 1727200001100));
      // Archive: the node leaves the default reads (roots) but carries no
      // trash row — archival is a state, deletion is an event.
      store.apply(env("object.update", { objectId: page, active: false }, 1727200001200));
      expect(store.getNode(page)!.is_active).toBe(0);
      expect(
        store.database.prepare("SELECT 1 FROM trash WHERE node_id = ?").get(page),
      ).toBeUndefined();
      expect(store.roots(WS).map((n) => n.id)).toEqual([other]);
      // Unarchive revives it.
      store.apply(env("object.update", { objectId: page, active: true }, 1727200001300));
      expect(store.getNode(page)!.is_active).toBe(1);
      expect(store.roots(WS).map((n) => n.id)).toEqual([page, other].sort());
      store.close();
    });

    it("archived children leave children() but stay parented (the tree is kept)", () => {
      const store = Store.open(adapter.makeBackend());
      const page = "0192a000-0000-7000-8000-000000000513";
      const child = "0192a000-0000-7000-8000-000000000514";
      store.apply(env("object.create", { objectId: page, contentAst: [{ type: "text", text: "P" }] }, 1727200001000));
      store.apply(env("object.create", { objectId: child, parentId: page, contentAst: [{ type: "text", text: "c" }] }, 1727200001100));
      store.apply(env("object.update", { objectId: child, active: false }, 1727200001200));
      expect(store.children(page)).toEqual([]);
      expect(store.getNode(child)!.parent_id).toBe(page);
      store.close();
    });

    it("on a class node the bit mirrors to the class registry projection", () => {
      const store = Store.open(adapter.makeBackend());
      const cls = "0192a000-0000-7000-8000-000000000515";
      store.apply(env("class.create", { classId: cls, contentAst: [{ type: "text", text: "Genre" }] }, 1727200001000));
      const registryActive = () =>
        (store.database.prepare("SELECT active FROM class WHERE id = ?").get(cls) as { active: number }).active;
      expect(registryActive()).toBe(1);
      store.apply(env("object.update", { objectId: cls, active: false }, 1727200001100));
      expect(store.getNode(cls)!.is_active).toBe(0);
      expect(registryActive()).toBe(0);
      store.apply(env("object.update", { objectId: cls, active: true }, 1727200001200));
      expect(store.getNode(cls)!.is_active).toBe(1);
      expect(registryActive()).toBe(1);
      store.close();
    });

    it("a LOCKED system class can never be archived (fails loud); unarchiving stays legal", () => {
      const store = Store.open(adapter.makeBackend());
      const year = "00000000-0000-0000-0001-000000000003";
      store.apply(env("class.create", { classId: year, contentAst: [{ type: "text", text: "Year" }] }, 1727200001000));
      expect(() =>
        store.apply(env("object.update", { objectId: year, active: false }, 1727200001100)),
      ).toThrow(LockedSystemClassError);
      expect(store.getNode(year)!.is_active).toBe(1);
      expect(() =>
        store.apply(env("object.update", { objectId: year, active: true }, 1727200001200)),
      ).not.toThrow();
      store.close();
    });

    it("a family base class refuses a direct archival write (toggle-managed); unarchive stays legal", () => {
      const store = Store.open(adapter.makeBackend());
      const task = "00000000-0000-0000-0001-000000000012";
      store.apply(env("class.create", { classId: task, contentAst: [{ type: "text", text: "Task" }] }, 1727200001000));
      // The Features toggle is the single archive path for the families.
      expect(() =>
        store.apply(env("object.update", { objectId: task, active: false }, 1727200001100)),
      ).toThrow(MoveGuardError);
      expect(store.getNode(task)!.is_active).toBe(1);
      expect(() =>
        store.apply(env("object.update", { objectId: task, active: true }, 1727200001200)),
      ).not.toThrow();
      store.close();
    });

    it("archive ≠ trash: object.restore is NOT the unarchive path (safe no-op)", () => {
      const store = Store.open(adapter.makeBackend());
      const page = "0192a000-0000-7000-8000-000000000516";
      store.apply(env("object.create", { objectId: page, contentAst: [{ type: "text", text: "P" }] }, 1727200001000));
      store.apply(env("object.update", { objectId: page, active: false }, 1727200001100));
      // No trash row → nothing to restore: the op no-ops, the bit stands.
      store.apply(env("object.restore", { objectId: page }, 1727200001200));
      expect(store.getNode(page)!.is_active).toBe(0);
      // The unarchive path is the archival write itself.
      store.apply(env("object.update", { objectId: page, active: true }, 1727200001300));
      expect(store.getNode(page)!.is_active).toBe(1);
      store.close();
    });
  });
}

for (const adapter of adapters) {
  describe(`class-node delete routing on ${adapter.name} (object.delete, membership rides)`, () => {
    const TASK = "00000000-0000-0000-0001-000000000012";
    const YEAR = "00000000-0000-0000-0001-000000000003";
    const QUOTE = "00000000-0000-0000-0001-000000000006";
    const GENRE = "0192a000-0000-7000-8000-000000000a23";
    const TASK_MEMBER = "0192a000-0000-7000-8000-000000000a22";
    const GENRE_MEMBER = "0192a000-0000-7000-8000-000000000a24";
    const SHELF = "0192a000-0000-7000-8000-000000000a25";
    const MOOD = "0192a000-0000-7000-8000-000000000a27";

    it("the canonical fixture exercises all four arms; membership survives each", () => {
      const store = Store.open(adapter.makeBackend());
      const fixture = loadFixture("object-delete-class-routing.json");
      const lockedDelete = fixture[5]!; // the year delete — arm 1 fails loud
      store.applyMany([...fixture.slice(0, 5), ...fixture.slice(6)]);
      // Arm 2 — family base (task): routed to the toggle, NOT trashed; the
      // family archives membership-preserving.
      expect(store.isFeatureEnabled(WS, "tasks")).toBe(false);
      expect(store.getFeatureRow(WS, "tasks")!.enabled).toBe(false);
      expect(store.getNode(TASK)!.is_active).toBe(0);
      expect(store.database.prepare("SELECT 1 FROM trash WHERE node_id = ?").get(TASK)).toBeUndefined();
      expect(store.getNode(TASK_MEMBER)!.class_ids).toBe(JSON.stringify([TASK]));
      // Arm 3 — system class (quote): archived, NOT trashed.
      expect(store.getNode(QUOTE)!.is_active).toBe(0);
      expect(store.database.prepare("SELECT 1 FROM trash WHERE node_id = ?").get(QUOTE)).toBeUndefined();
      expect(
        (store.database.prepare("SELECT active FROM class WHERE id = ?").get(QUOTE) as { active: number }).active,
      ).toBe(0);
      // Arm 4 — user class (Genre): plain trash row, memberships intact.
      expect(store.getNode(GENRE)!.is_active).toBe(0);
      expect(store.database.prepare("SELECT 1 FROM trash WHERE node_id = ?").get(GENRE)).toBeDefined();
      expect(store.getNode(GENRE_MEMBER)!.class_ids).toBe(JSON.stringify([GENRE]));
      // The registry projection mirrors the user-class lifecycle end to end:
      // the trashed Genre's row mirrored OFF…
      expect(registryRow(store, GENRE).active).toBe(0);
      // …the trashed-then-restored Shelf's row mirrored OFF then back ON…
      expect(store.getNode(SHELF)!.is_active).toBe(1);
      expect(store.database.prepare("SELECT 1 FROM trash WHERE node_id = ?").get(SHELF)).toBeUndefined();
      expect(registryRow(store, SHELF).active).toBe(1);
      // …the permanently purged Mood's node AND registry row are both gone.
      expect(store.getNode(MOOD)).toBeUndefined();
      expect(store.database.prepare("SELECT 1 FROM class WHERE id = ?").get(MOOD)).toBeUndefined();
      // Arm 1 — the locked delete still throws when applied deliberately.
      expect(() => store.apply(lockedDelete)).toThrow(LockedSystemClassError);
      expect(store.getNode(YEAR)!.is_active).toBe(1);
      store.close();
    });

    it("arm 1: a LOCKED system class delete fails loud, never applied", () => {
      const store = Store.open(adapter.makeBackend());
      const year = "00000000-0000-0000-0001-000000000003";
      const table = "00000000-0000-0000-0001-000000000015";
      for (const [id, title, at] of [
        [year, "Year", 1727200001000],
        [table, "Table", 1727200001100],
      ] as const) {
        store.apply(env("class.create", { classId: id, contentAst: [{ type: "text", text: title }] }, at));
        expect(() =>
          store.apply(env("object.delete", { objectId: id }, at + 100)),
        ).toThrow(LockedSystemClassError);
        expect(() =>
          store.apply(env("object.delete", { objectId: id, permanent: true }, at + 200)),
        ).toThrow(LockedSystemClassError);
        expect(store.getNode(id)!.is_active).toBe(1);
      }
      store.close();
    });

    it("arm 2: the routed delete and a racing toggle converge under either order", () => {
      const base = [
        env("class.create", { classId: TASK, contentAst: [{ type: "text", text: "Task" }] }, 1727200011000),
        env("object.create", { objectId: TASK_MEMBER, classIds: [TASK], contentAst: [{ type: "text", text: "Buy milk" }] }, 1727200011100),
      ];
      const routedDelete = env("object.delete", { objectId: TASK }, 1727200011200);
      const reenable = env("workspace.feature.set", { feature: "tasks", enabled: true }, 1727200011300);
      const forward = Store.open(adapter.makeBackend());
      forward.applyMany([...base, routedDelete, reenable]);
      const backward = Store.open(adapter.makeBackend());
      backward.applyMany([...base, reenable, routedDelete]);
      expect(dumpDb(forward)).toEqual(dumpDb(backward));
      // The enable (@11300) wins the (ws, tasks) slot over the routed
      // delete (@11200); the class revives with its membership intact.
      expect(forward.isFeatureEnabled(WS, "tasks")).toBe(true);
      expect(forward.getNode(TASK)!.is_active).toBe(1);
      expect(forward.getNode(TASK_MEMBER)!.class_ids).toBe(JSON.stringify([TASK]));
      forward.close();
      backward.close();
    });

    it("arm 4: a trashed user class restores with every assignment intact", () => {
      const store = Store.open(adapter.makeBackend());
      const cls = "0192a000-0000-7000-8000-0000000000e1";
      const member = "0192a000-0000-7000-8000-0000000000e2";
      store.apply(env("class.create", { classId: cls, contentAst: [{ type: "text", text: "Genre" }] }, 1727200011000));
      store.apply(env("object.create", { objectId: member, classIds: [cls], contentAst: [{ type: "text", text: "X" }] }, 1727200011100));
      store.apply(env("object.delete", { objectId: cls }, 1727200011200));
      // Membership RIDES: the pair survives the trash event.
      expect(store.getNode(member)!.class_ids).toBe(JSON.stringify([cls]));
      expect(
        store.database.prepare("SELECT 1 FROM class_member_set WHERE node_id = ? AND class_id = ? AND present = 1").get(member, cls),
      ).toBeDefined();
      // The registry projection follows the node into the trash…
      expect(registryRow(store, cls).active).toBe(0);
      store.apply(env("object.restore", { objectId: cls }, 1727200011300));
      expect(store.getNode(cls)!.is_active).toBe(1);
      expect(store.getNode(member)!.class_ids).toBe(JSON.stringify([cls]));
      // …and mirrors back with the restore.
      expect(registryRow(store, cls).active).toBe(1);
      store.close();
    });

    it("arm 4 permanent: a permanently deleted user class leaves memberships as the dangling-reference state", () => {
      const store = Store.open(adapter.makeBackend());
      const cls = "0192a000-0000-7000-8000-0000000000e3";
      const member = "0192a000-0000-7000-8000-0000000000e4";
      store.apply(env("class.create", { classId: cls, contentAst: [{ type: "text", text: "Genre" }] }, 1727200011000));
      store.apply(env("object.create", { objectId: member, classIds: [cls], contentAst: [{ type: "text", text: "X" }] }, 1727200011100));
      store.apply(env("object.delete", { objectId: cls, permanent: true }, 1727200011200));
      // Membership rides even here: the pairs stand (the class pill renders
      // the dangling reference — SCHEMA.md "Content grammar", Fork 3).
      expect(store.getNode(cls)).toBeUndefined();
      expect(store.getNode(member)!.class_ids).toBe(JSON.stringify([cls]));
      // The registry projection dies with the node — no ghost row.
      expect(store.database.prepare("SELECT 1 FROM class WHERE id = ?").get(cls)).toBeUndefined();
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
      store.apply(env("object.create", { objectId: page, contentAst: [{ type: "text", text: "P" }]}, 1727200001000));
      store.apply(env("object.create", { objectId: tagA, contentAst: [{ type: "text", text: "tag A" }]}, 1727200001100));
      store.apply(env("object.create", { objectId: tagB, contentAst: [{ type: "text", text: "tag B" }]}, 1727200001200));
      // Assign: the create carrier re-issue (same pattern as classes).
      store.apply(env("object.create", { objectId: page, tagIds: [tagA, tagB] }, 1727200002000));
      expect(store.getNode(page)!.tag_ids).toBe(JSON.stringify([tagA, tagB].sort()));
      // Unassign tombstones the pair.
      store.apply(env("tag.unassign", { objectId: page, tagId: tagA }, 1727200003000));
      expect(store.getNode(page)!.tag_ids).toBe(JSON.stringify([tagB]));
      // A stale re-add (lower HLC than the remove) loses.
      store.apply(env("object.create", { objectId: page, tagIds: [tagA] }, 1727200002500));
      expect(store.getNode(page)!.tag_ids).toBe(JSON.stringify([tagB]));
      // A newer re-add wins.
      store.apply(env("object.create", { objectId: page, tagIds: [tagA] }, 1727200004000));
      expect(store.getNode(page)!.tag_ids).toBe(JSON.stringify([tagA, tagB].sort()));
      store.close();
    });
  });
}

const TASK_CLASS = "00000000-0000-0000-0001-000000000012";
const EVENT_CLASS = "00000000-0000-0000-0001-000000000040";
const MEETING_CLASS = "00000000-0000-0000-0001-000000000039";
const BIRTHDAY_CLASS = "00000000-0000-0000-0001-000000000041";

for (const adapter of adapters) {
  describe(`workspace features on ${adapter.name}`, () => {
    it("F2: an empty table means all enabled; rows list only toggled features", () => {
      const store = Store.open(adapter.makeBackend());
      expect(store.isFeatureEnabled(WS, "tasks")).toBe(true);
      expect(store.isFeatureEnabled(WS, "events")).toBe(true);
      expect(store.isFeatureEnabled(WS, "meetings")).toBe(true);
      expect(store.listFeatureRows(WS)).toEqual([]);
      expect(store.getFeatureRow(WS, "tasks")).toBeUndefined();
      store.close();
    });

    it("F3: toggle-off archives the family membership-preserving; toggle-on revives", () => {
      const store = Store.open(adapter.makeBackend());
      store.apply(env("class.create", { classId: TASK_CLASS, contentAst: [{ type: "text", text: "Task" }] }, 1727200011000));
      store.apply(env("class.create", { classId: EVENT_CLASS, contentAst: [{ type: "text", text: "Event" }] }, 1727200011100));
      const member = "0192a000-0000-7000-8000-000000000615";
      store.apply(env("object.create", { objectId: member, classIds: [TASK_CLASS], contentAst: [{ type: "text", text: "Buy milk" }] }, 1727200011200));

      store.apply(env("workspace.feature.set", { feature: "tasks", enabled: false }, 1727200012000));
      expect(store.isFeatureEnabled(WS, "tasks")).toBe(false);
      // The class node + registry row archive; the membership pair survives.
      expect(store.getNode(TASK_CLASS)!.is_active).toBe(0);
      expect(registryRow(store, TASK_CLASS).active).toBe(0);
      expect(store.getNode(member)!.class_ids).toBe(JSON.stringify([TASK_CLASS]));
      expect(
        (store.database.prepare("SELECT present FROM class_member_set WHERE node_id = ? AND class_id = ?").get(member, TASK_CLASS) as { present: number }).present,
      ).toBe(1);
      // Untouched families/classes stay enabled.
      expect(store.isFeatureEnabled(WS, "events")).toBe(true);
      expect(store.getNode(EVENT_CLASS)!.is_active).toBe(1);
      expect(store.featureInstanceCount(WS, "tasks")).toBe(1);

      store.apply(env("workspace.feature.set", { feature: "tasks", enabled: true }, 1727200013000));
      expect(store.isFeatureEnabled(WS, "tasks")).toBe(true);
      expect(store.getNode(TASK_CLASS)!.is_active).toBe(1);
      expect(registryRow(store, TASK_CLASS).active).toBe(1);
      expect(store.getNode(member)!.class_ids).toBe(JSON.stringify([TASK_CLASS]));
      store.close();
    });

    it("the events cascade: disabling events archives event+meeting+birthday; meetings-off survives an events re-enable", () => {
      const store = Store.open(adapter.makeBackend());
      store.apply(env("class.create", { classId: EVENT_CLASS, contentAst: [{ type: "text", text: "Event" }] }, 1727200011000));
      store.apply(env("class.create", { classId: MEETING_CLASS, contentAst: [{ type: "text", text: "Meeting" }] }, 1727200011100));
      store.apply(env("class.create", { classId: BIRTHDAY_CLASS, contentAst: [{ type: "text", text: "Birthday" }] }, 1727200011200));

      // Meetings alone off: only the meeting class archives.
      store.apply(env("workspace.feature.set", { feature: "meetings", enabled: false }, 1727200012000));
      expect(store.getNode(MEETING_CLASS)!.is_active).toBe(0);
      expect(store.getNode(EVENT_CLASS)!.is_active).toBe(1);
      expect(store.getNode(BIRTHDAY_CLASS)!.is_active).toBe(1);

      // Events off: the whole family archives (meeting was already off).
      store.apply(env("workspace.feature.set", { feature: "events", enabled: false }, 1727200012100));
      expect(store.getNode(EVENT_CLASS)!.is_active).toBe(0);
      expect(store.getNode(MEETING_CLASS)!.is_active).toBe(0);
      expect(store.getNode(BIRTHDAY_CLASS)!.is_active).toBe(0);

      // Events back on: event + birthday revive, meeting stays archived
      // (its own family is still off — the cascade re-derives per class).
      store.apply(env("workspace.feature.set", { feature: "events", enabled: true }, 1727200012200));
      expect(store.getNode(EVENT_CLASS)!.is_active).toBe(1);
      expect(store.getNode(BIRTHDAY_CLASS)!.is_active).toBe(1);
      expect(store.getNode(MEETING_CLASS)!.is_active).toBe(0);

      // Meetings back on too: the meeting class revives.
      store.apply(env("workspace.feature.set", { feature: "meetings", enabled: true }, 1727200012300));
      expect(store.getNode(MEETING_CLASS)!.is_active).toBe(1);
      store.close();
    });

    it("the tasks enable authors the six-schema family idempotently (fixed ids, option ids)", () => {
      const store = Store.open(adapter.makeBackend());
      const enableOp = env("workspace.feature.set", { feature: "tasks", enabled: true }, 1727200012000);
      store.apply(enableOp);
      const node = store.getNode(TASK_CLASS)!;
      expect(node.is_class).toBe(1);
      expect(node.is_active).toBe(1);
      expect(JSON.parse(node.content)).toEqual([{ type: "text", text: "Task" }]);
      const schemas = store.database
        .prepare("SELECT id, name, type FROM property_schema WHERE id LIKE '00000000-0000-0000-0003-%'")
        .all() as Array<{ id: string; name: string; type: string }>;
      expect(schemas.map((row) => row.name).sort()).toEqual([
        "Closed",
        "Deadline",
        "Priority",
        "Recurrence",
        "Scheduled",
        "Status",
      ]);
      // Owner ruling 2026-10-20 (the seed-scope audit): the whole task
      // family seeds at GLOBAL scope (Status "can be reused for other
      // nodes") — NULL scope_class_ids; the bindings below stay per-class
      // config.
      const scopes = store.database
        .prepare(
          "SELECT id, scope_class_ids FROM property_schema WHERE id LIKE '00000000-0000-0000-0003-00000000000_'",
        )
        .all() as Array<{ id: string; scope_class_ids: string | null }>;
      expect(scopes).toHaveLength(6);
      for (const row of scopes) {
        expect(row.scope_class_ids).toBeNull();
      }
      const status = store.database
        .prepare("SELECT options FROM property_schema WHERE id = ?")
        .get("00000000-0000-0000-0003-000000000001") as { options: string };
      const options = JSON.parse(status.options) as Array<{ id: string; label: string; icon?: string; color?: string }>;
      expect(options.map((option) => option.label)).toEqual([
        "Backlog",
        "Pending",
        "Doing",
        "Reviewing",
        "Done",
        "Cancelled",
      ]);
      expect(options[1]!.id).toBe("00000000-0000-0000-0004-000000000009");
      // The designed circle-family glyphs + colors (yellow
      // pending, blue review, red cancel, green done — owner-mandated).
      expect(options.map((option) => [option.icon, option.color])).toEqual([
        ["mdiCircleOutline", "gray"],
        ["mdiCircle", "yellow"],
        ["mdiCircleHalfFull", "orange"],
        ["mdiEyeCircleOutline", "blue"],
        ["mdiCheckCircle", "green"],
        ["mdiCloseCircle", "red"],
      ]);
      // The six binding rows carry no order (sequence retired 2026-10-21,
      // store v26 — panels sort alphabetically at read time); the id order
      // asserts the full family is bound.
      const bindings = store.database
        .prepare("SELECT property_schema_id FROM class_property WHERE class_id = ? ORDER BY property_schema_id")
        .all(TASK_CLASS) as Array<{ property_schema_id: string }>;
      expect(bindings.map((binding) => binding.property_schema_id)).toEqual([
        "00000000-0000-0000-0003-000000000001",
        "00000000-0000-0000-0003-000000000002",
        "00000000-0000-0000-0003-000000000003",
        "00000000-0000-0000-0003-000000000004",
        "00000000-0000-0000-0003-000000000005",
        "00000000-0000-0000-0003-000000000006",
      ]);
      // The Status SCHEMA carries display 'bullet' (property-level);
      // the binding rows stay flag-free (active only — the rebuilds dropped
      // the render contracts (v14), required/default_value (v25) and
      // sequence (v26)).
      const statusSchema = store.database
        .prepare("SELECT display FROM property_schema WHERE id = ?")
        .get("00000000-0000-0000-0003-000000000001") as { display: string | null };
      expect(statusSchema.display).toBe("bullet");
      const bindingColumns = (
        store.database.prepare("PRAGMA table_info(class_property)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(bindingColumns).not.toContain("display");
      expect(bindingColumns).not.toContain("hide_when_empty");
      expect(bindingColumns).not.toContain("required");
      expect(bindingColumns).not.toContain("default_value");
      // Idempotent: replaying the SAME envelope is skipped wholesale
      // (applied_envelope), and a stale re-enable loses the LWW row.
      const before = dumpDb(store);
      store.apply(enableOp);
      expect(dumpDb(store)).toEqual(before);
      const stale = env("workspace.feature.set", { feature: "tasks", enabled: true }, 1727200011500);
      const result = store.apply(stale);
      expect(result.ignored).toBe(true);
      expect(dumpDb(store)).toEqual(before);
      store.close();
    });

    it("workspace-feature-set fixture converges regardless of application order", () => {
      const fixture = loadFixture("workspace-feature-set.json");
      const forward = makeAdapterStore();
      forward.applyMany(fixture);
      const backward = makeAdapterStore();
      backward.applyMany([...fixture].reverse());
      expect(dumpDb(forward)).toEqual(dumpDb(backward));
      // LWW winners: tasks disabled (higher-HLC phone disable), events
      // disabled, sources re-enabled.
      expect(forward.isFeatureEnabled(WS, "tasks")).toBe(false);
      expect(forward.isFeatureEnabled(WS, "events")).toBe(false);
      expect(forward.isFeatureEnabled(WS, "sources")).toBe(true);
      const row = forward.getFeatureRow(WS, "tasks")!;
      expect(row.enabled).toBe(false);
      expect(row.settings).toBeUndefined();
      // The settings tail: the final sources winner carried settings; the
      // intermediate old-shape re-enable (envelope 8) cleared them to NULL
      // under the same LWW comparator, and the reverse-order replay lands
      // on the identical row.
      expect(forward.getFeatureRow(WS, "sources")).toEqual({
        feature: "sources",
        enabled: true,
        settings: { citekeyPattern: "[auth:lower][year]", autoCitekey: true },
      });
      expect(backward.getFeatureRow(WS, "sources")).toEqual(forward.getFeatureRow(WS, "sources"));
      // The racing enable still ran the family ensure: the task class family
      // exists on BOTH replicas (archived per the winning disable).
      expect(forward.getNode(TASK_CLASS)!.is_active).toBe(0);
      expect(backward.getNode(TASK_CLASS)!.is_active).toBe(0);
      forward.close();
      backward.close();
    });

    it("workspace.feature.set settings: LWW with the row, NULL for absent, distinct from {}", () => {
      const store = makeAdapterStore();
      const sources = (physical: number, payload: Record<string, unknown>) =>
        env("workspace.feature.set", { feature: "sources", ...payload }, physical);
      // Set: settings persist and read back through getFeatureRow + the list.
      store.apply(sources(1727200010700, {
        enabled: true,
        settings: { citekeyPattern: "[auth:lower][year]", autoCitekey: true },
      }));
      expect(store.getFeatureRow(WS, "sources")!.settings).toEqual({
        citekeyPattern: "[auth:lower][year]",
        autoCitekey: true,
      });
      expect(store.listFeatureRows(WS).find((r) => r.feature === "sources")!.settings).toEqual({
        citekeyPattern: "[auth:lower][year]",
        autoCitekey: true,
      });
      // Old shape wins: the winning payload carries no settings key, so the
      // row stores NULL and reads back undefined (settings are gone).
      store.apply(sources(1727200010800, { enabled: true }));
      expect(store.getFeatureRow(WS, "sources")!.settings).toBeUndefined();
      // An empty record is a REAL value, not absent: it round-trips as {}.
      store.apply(sources(1727200010900, { enabled: true, settings: {} }));
      expect(store.getFeatureRow(WS, "sources")!.settings).toEqual({});
      // Stale settings op: loses the LWW compare, the row is untouched.
      const before = dumpDb(store);
      const stale = sources(1727200010850, {
        enabled: false,
        settings: { citekeyPattern: "[stale]" },
      });
      expect(store.apply(stale).ignored).toBe(true);
      expect(dumpDb(store)).toEqual(before);
      expect(store.getFeatureRow(WS, "sources")!.settings).toEqual({});
      expect(store.isFeatureEnabled(WS, "sources")).toBe(true);
      store.close();
    });

    it("journal: a surfaces-only toggle — LWW row, no family derivation, no instance count", () => {
      const store = makeAdapterStore();
      // The date chain stays always-on: the toggle manages views, not classes.
      const year = "00000000-0000-0000-0001-000000000003";
      store.apply(env("class.create", { classId: year, contentAst: [{ type: "text", text: "Year" }] }, 1727200001000));
      store.apply(env("workspace.feature.set", { feature: "journal", enabled: false }, 1727200001100));
      expect(store.isFeatureEnabled(WS, "journal")).toBe(false);
      expect(store.getFeatureRow(WS, "journal")).toEqual({ feature: "journal", enabled: false });
      // No family classes derive from it: the year node is untouched.
      expect(store.getNode(year)!.is_active).toBe(1);
      expect(store.featureInstanceCount(WS, "journal")).toBe(0);
      // LWW: a later enable wins.
      store.apply(env("workspace.feature.set", { feature: "journal", enabled: true }, 1727200001200));
      expect(store.isFeatureEnabled(WS, "journal")).toBe(true);
      expect(store.getNode(year)!.is_active).toBe(1);
      store.close();
    });

    it("code-block fixture: the token survives promotion; hr flattens away", () => {
      const store = makeAdapterStore();
      store.applyMany(loadFixture("code-block.json"));
      const block = "0192a000-0000-7000-8000-000000000621";
      const promoted = JSON.parse(store.getNode(block)!.content) as Array<{ type: string }>;
      expect(promoted).toEqual([
        { type: "text", text: "before after" },
        { type: "code_block", language: "python", text: "print('hi')\nprint('bye')" },
      ]);
      const plain = "0192a000-0000-7000-8000-000000000623";
      expect(JSON.parse(store.getNode(plain)!.content)).toEqual([
        { type: "code_block", text: "plain snippet" },
      ]);
      store.close();
    });

    it("hr fixture: inline blocks keep the token; promotion stringifies it out", () => {
      const store = makeAdapterStore();
      store.applyMany(loadFixture("hr.json"));
      const block = "0192a000-0000-7000-8000-000000000631";
      expect(JSON.parse(store.getNode(block)!.content)).toEqual([
        { type: "text", text: "above below" },
      ]);
      const ruleOnly = "0192a000-0000-7000-8000-000000000633";
      expect(JSON.parse(store.getNode(ruleOnly)!.content)).toEqual([
        { type: "hr" },
      ]);
      store.close();
    });

    it("embed-ref-view fixture: the view field applies verbatim (default absent)", () => {
      const store = makeAdapterStore();
      store.applyMany(loadFixture("embed-ref-view.json"));
      const block = "0192a000-0000-7000-8000-000000000642";
      expect(JSON.parse(store.getNode(block)!.content)).toEqual([
        { type: "embed_ref", nodeId: "0192a000-0000-7000-8000-000000000640" },
        {
          type: "embed_ref",
          nodeId: "0192a000-0000-7000-8000-000000000640",
          view: "wide_card",
        },
      ]);
      store.close();
    });

    function makeAdapterStore(): Store {
      return Store.open(adapter.makeBackend());
    }
  });
}

function registryRow(store: Store, classId: string): { active: number } {
  return store.database.prepare("SELECT active FROM class WHERE id = ?").get(classId) as {
    active: number;
  };
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
    source.apply(env("object.create", { objectId: page, contentAst: [{ type: "text", text: "P" }]}, 1727200001000));
    source.apply(env("class.create", { classId: cls, contentAst: [{ type: "text", text: "Genre" }]}, 1727200001100));
    source.apply(env("object.create", { objectId: page, classIds: [cls] }, 1727200001200));
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

// --- v19 -> v20: the bulk-replay read indexes -----------------------------------

describe.each(adapters)("$name: v19 -> v20 migration (the bulk-replay read indexes)", ({ makeBackend }) => {
  const indexNames = (db: Store["database"], table: string): string[] =>
    (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]).map((row) => row.name);

  it("fresh stores carry the alias-source and child-order-child indexes at v20", () => {
    const store = Store.open(makeBackend());
    expect(store.database.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(indexNames(store.database, "node")).toContain("idx_node_aliased_source");
    expect(indexNames(store.database, "node_child_order")).toContain("idx_node_child_order_child");
  });

  it("a v19-stamped store migrates to v20 and gains both indexes", () => {
    const store = Store.open(makeBackend());
    const db = store.database;
    // Simulate a pre-v20 database: drop the indexes and rewind the stamp.
    db.exec("DROP INDEX IF EXISTS idx_node_aliased_source;");
    db.exec("DROP INDEX IF EXISTS idx_node_child_order_child;");
    db.pragma("user_version = 19");

    migrate(db, "fts5");

    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(indexNames(db, "node")).toContain("idx_node_aliased_source");
    expect(indexNames(db, "node_child_order")).toContain("idx_node_child_order_child");
  });
});


// --- v7 -> v8 migration: node_type -> (is_class, is_embedded) -------------

/**
 * The v7 node DDL (SCHEMA_VERSION 7): the retired node_type enumeration with
 * the two old placement CHECKs. Used to build a v7-shaped database in place
 * and drive migrate()'s table-rebuild step directly.
 */
const NODE_DDL_V7 = `
CREATE TABLE node (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    node_type TEXT NOT NULL DEFAULT 'block'
        CHECK (node_type IN ('page', 'block', 'class')),
    parent_id TEXT REFERENCES node(id),
    class_ids TEXT NOT NULL DEFAULT '[]',
    class_order TEXT NOT NULL DEFAULT '[]',
    tag_ids TEXT NOT NULL DEFAULT '[]',
    name TEXT,
    content TEXT NOT NULL DEFAULT '[]',
    icon TEXT,
    color TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT,
    updated_at TEXT,
    created_by TEXT,
    updated_by TEXT,
    hlc_physical INTEGER NOT NULL DEFAULT 0,
    hlc_logical INTEGER NOT NULL DEFAULT 0,
    actor_id TEXT,
    CHECK (node_type <> 'block' OR parent_id IS NOT NULL),
    CHECK (node_type <> 'class' OR parent_id IS NULL)
);
CREATE INDEX idx_node_workspace ON node (workspace_id);
CREATE INDEX idx_node_parent ON node (parent_id);
`;

describe.each(adapters)("$name: v7 -> v8 migration (node_type -> is_class/is_embedded)", ({ makeBackend }) => {
  it("rebuilds the node table mapping page/block/class, recreates indexes and stamps v8", () => {
    const store = Store.open(makeBackend());
    const db = store.database;
    // Rebuild a v7-shaped node table holding one row of each old kind.
    db.exec("DROP TABLE node;");
    db.exec(NODE_DDL_V7);
    db.exec(
      `INSERT INTO node (id, workspace_id, node_type, parent_id, class_ids, tag_ids, content) VALUES
         ('pg', 'ws', 'page', NULL, '["c1"]', '["t1"]', '[{"type":"text","text":"Page"}]'),
         ('bl', 'ws', 'block', 'pg', '[]', '[]', '[]'),
         ('cl', 'ws', 'class', NULL, '[]', '[]', '[{"type":"text","text":"Class"}]');`,
    );
    db.pragma("user_version = 7");

    migrate(db, "fts5");

    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    const columns = (db.prepare("PRAGMA table_info(node)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).not.toContain("node_type");
    expect(columns).toContain("is_class");
    expect(columns).toContain("is_embedded");
    // The boolean mapping through v8 + v21: page -> (0, 0), block -> (0, 1),
    // class -> (1, 0) — the v21 inversion maps the old present_as_main to
    // is_embedded and converges class rows to the appliers' canonical 0.
    const rows = db.prepare("SELECT id, is_class, is_embedded, parent_id FROM node ORDER BY id").all() as
      Array<{ id: string; is_class: number; is_embedded: number; parent_id: string | null }>;
    expect(rows).toEqual([
      { id: "bl", is_class: 0, is_embedded: 1, parent_id: "pg" },
      { id: "cl", is_class: 1, is_embedded: 0, parent_id: null },
      { id: "pg", is_class: 0, is_embedded: 0, parent_id: null },
    ]);
    // Non-enum columns ride through the rebuild untouched.
    const page = db.prepare("SELECT class_ids, tag_ids, content FROM node WHERE id = 'pg'").get() as
      { class_ids: string; tag_ids: string; content: string };
    expect(JSON.parse(page.class_ids)).toEqual(["c1"]);
    expect(JSON.parse(page.tag_ids)).toEqual(["t1"]);
    expect(JSON.parse(page.content)).toEqual([{ type: "text", text: "Page" }]);
    // Both node indexes are recreated on the rebuilt table (plus the v15
    // list-reads index).
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_node%'").all() as
        { name: string }[]
    ).map((r) => r.name);
    expect(indexes).toContain("idx_node_workspace");
    expect(indexes).toContain("idx_node_parent");
    expect(indexes).toContain("idx_node_list_reads");
    // The new placement CHECK pins classes to roots on the migrated table.
    expect(() =>
      db.prepare("INSERT INTO node (id, workspace_id, is_class, parent_id) VALUES ('x', 'ws', 1, 'pg')").run(),
    ).toThrow(/CHECK constraint failed/);
    store.close();
  });

  it("is idempotent on an already-v8 database", () => {
    const store = Store.open(makeBackend());
    store.apply(createPage(NODE_PAGE, 1727200000000));
    migrate(store.database, "fts5");
    expect(store.database.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(store.getNode(NODE_PAGE)).toMatchObject({ is_class: 0, is_embedded: 0 });
    store.close();
  });
});


// --- v15: the render-path list-reads index --------------------------------------

describe.each(adapters)("$name: v15 — idx_node_list_reads", ({ makeBackend }) => {
  const nodeIndexes = (db: { prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] } }): string[] =>
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_node%'")
        .all() as { name: string }[]
    ).map((r) => r.name);

  it("exists on a fresh database at the current schema version", () => {
    const store = Store.open(makeBackend());
    expect(nodeIndexes(store.database)).toContain("idx_node_list_reads");
    expect(store.database.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    store.close();
  });

  it("is added idempotently when a v14 database migrates", () => {
    const store = Store.open(makeBackend());
    store.apply(createPage(NODE_PAGE, 1727200000000));
    // Simulate a pre-v15 database: drop the index and rewind the version.
    store.database.exec("DROP INDEX IF EXISTS idx_node_list_reads;");
    store.database.pragma("user_version = 14");
    migrate(store.database, "fts5");
    expect(store.database.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(nodeIndexes(store.database)).toContain("idx_node_list_reads");
    // Idempotent: a second migrate is a no-op that stays current.
    migrate(store.database, "fts5");
    expect(nodeIndexes(store.database)).toContain("idx_node_list_reads");
    store.close();
  });
});

// --- v16: the wire node fields (cover/banner asset refs + the alias target) ------

describe.each(adapters)("$name: v16 — wire node fields", ({ makeBackend }) => {
  const PAGE = "0192a000-0000-7000-8000-00000000052a";
  const ASSET = "0192a000-0000-7000-8000-00000000052b";
  const MAIN = "0192a000-0000-7000-8000-00000000052c";

  function makeStore(): Store {
    return Store.open(makeBackend());
  }

  it("the wire-fields fixture lands set + clear through object.update", () => {
    const store = makeStore();
    const [createPage_, createAsset, createMain, ...updates] = loadFixture("object-wire-fields.json");
    store.apply(createPage_!);
    store.apply(createAsset!);
    store.apply(createMain!);
    const row = () => store.getNode(PAGE);
    expect(row()).toMatchObject({
      cover_asset_id: null,
      banner_asset_id: null,
      aliased_node_id: null,
    });
    store.apply(updates[0]!); // coverAssetId = ASSET
    expect(row()).toMatchObject({ cover_asset_id: ASSET });
    store.apply(updates[1]!); // bannerAssetId = ASSET, aliasedNodeId = MAIN
    expect(row()).toMatchObject({ banner_asset_id: ASSET, aliased_node_id: MAIN });
    store.apply(updates[2]!); // aliasedNodeId = null (clear)
    expect(row()).toMatchObject({ aliased_node_id: null, cover_asset_id: ASSET });
    store.apply(updates[3]!); // coverAssetId = null
    expect(row()).toMatchObject({ cover_asset_id: null, banner_asset_id: ASSET });
    store.apply(updates[4]!); // bannerAssetId = null
    expect(row()).toMatchObject({
      cover_asset_id: null,
      banner_asset_id: null,
      aliased_node_id: null,
    });
    store.apply(updates[5]!); // description = "Subtitle text"
    expect(row()).toMatchObject({ description: "Subtitle text" });
    store.apply(updates[6]!); // description = null (clear)
    expect(row()).toMatchObject({ description: null });
    store.close();
  });

  it("absence preserves, present-null clears, and the fields ride the row LWW", () => {
    const store = makeStore();
    store.apply(createPage(PAGE, 1727200000000));
    const setAll = env(
      "object.update",
      { objectId: PAGE, coverAssetId: ASSET, bannerAssetId: ASSET, aliasedNodeId: MAIN },
      1727200001000,
    );
    store.apply(setAll);
    // An absent field is not a write: an icon-only update keeps the fields.
    store.apply(env("object.update", { objectId: PAGE, icon: "mdiStar" }, 1727200002000));
    expect(store.getNode(PAGE)).toMatchObject({
      icon: "mdiStar",
      cover_asset_id: ASSET,
      banner_asset_id: ASSET,
      aliased_node_id: MAIN,
    });
    // A stale-HLC update loses the row LWW race: nothing changes.
    store.apply(
      env("object.update", { objectId: PAGE, coverAssetId: null }, 1727200000500),
    );
    expect(store.getNode(PAGE)?.cover_asset_id).toBe(ASSET);
    // The winning clear.
    store.apply(env("object.update", { objectId: PAGE, coverAssetId: null }, 1727200003000));
    expect(store.getNode(PAGE)?.cover_asset_id).toBeNull();
    store.close();
  });

  it("adds the three columns idempotently when a v15 database migrates", () => {
    const store = makeStore();
    store.apply(createPage(PAGE, 1727200000000));
    // Simulate a pre-v16 database: rewind the version and drop the columns
    // (SQLite 3.35+ DROP COLUMN; the v14 index-predecent shape — the v20
    // alias-source index references aliased_node_id, so it drops first).
    store.database.exec(`
      DROP INDEX IF EXISTS idx_node_aliased_source;
      ALTER TABLE node DROP COLUMN cover_asset_id;
      ALTER TABLE node DROP COLUMN banner_asset_id;
      ALTER TABLE node DROP COLUMN aliased_node_id;
    `);
    store.database.pragma("user_version = 15");
    migrate(store.database, "fts5");
    expect(store.database.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(store.getNode(PAGE)).toMatchObject({
      cover_asset_id: null,
      banner_asset_id: null,
      aliased_node_id: null,
    });
    // Idempotent: a second migrate is a no-op that stays current.
    migrate(store.database, "fts5");
    expect(store.database.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    // The migrated table still maps the fields on update.
    store.apply(env("object.update", { objectId: PAGE, aliasedNodeId: MAIN }, 1727200001000));
    expect(store.getNode(PAGE)?.aliased_node_id).toBe(MAIN);
    store.close();
  });
});

// --- v17: the alias resolved-target materialization ------------------------------

describe.each(adapters)("$name: edge.resolved_target_id (v17)", ({ makeBackend }) => {
  const MAIN = "0192a000-0000-7000-8000-0000000005a1";
  const ALIAS = "0192a000-0000-7000-8000-0000000005a2";
  const CHAIN = "0192a000-0000-7000-8000-0000000005a3";
  const OTHER = "0192a000-0000-7000-8000-0000000005a4";
  const SOURCE = "0192a000-0000-7000-8000-0000000005a5";
  const BLOCK = "0192a000-0000-7000-8000-0000000005a6";

  function makeStore(): Store {
    return Store.open(makeBackend());
  }

  const edgeRows = (store: Store) =>
    store.database
      .prepare(
        "SELECT source_id, target_id, resolved_target_id, type FROM edge ORDER BY source_id, type, id",
      )
      .all() as Array<{ source_id: string; target_id: string | null; resolved_target_id: string | null; type: string }>;

  /** The alias-world envelopes: MAIN ← ALIAS ← CHAIN, one mention edge
   *  targeting each of ALIAS / CHAIN / OTHER, authored BEFORE the alias
   *  writes land (the re-resolution maintenance path). */
  function worldEnvelopes(): Envelope[] {
    return [
      createPage(MAIN, 1727200000000),
      createPage(ALIAS, 1727200000100),
      createPage(CHAIN, 1727200000200),
      createPage(OTHER, 1727200000300),
      createPage(SOURCE, 1727200000400),
      env("object.create", { objectId: BLOCK, parentId: SOURCE, isEmbedded: true }, 1727200000500),
      // One content write carrying all three mentions (a contentAst write
      // replaces the stream — three separate updates would leave only the
      // last token standing).
      env(
        "object.update",
        {
          objectId: BLOCK,
          contentAst: [
            { type: "text", text: "see " },
            { type: "mention", targetNodeId: ALIAS, text: "a" },
            { type: "mention", targetNodeId: CHAIN, text: "c" },
            { type: "mention", targetNodeId: OTHER, text: "o" },
          ],
        },
        1727200000600,
      ),
      env("object.update", { objectId: ALIAS, aliasedNodeId: MAIN }, 1727200000900),
      env("object.update", { objectId: CHAIN, aliasedNodeId: ALIAS }, 1727200001000),
    ];
  }

  function seedWorld(store: Store): void {
    store.applyMany(worldEnvelopes());
  }

  it("materializes the alias terminal at write time; non-alias targets resolve to themselves", () => {
    const store = makeStore();
    seedWorld(store);
    const rows = edgeRows(store);
    // Both alias-targeted edges resolve to the terminal; the plain target is
    // its own resolution.
    const byTarget = new Map(rows.map((r) => [r.target_id, r.resolved_target_id]));
    expect(byTarget.get(ALIAS)).toBe(MAIN);
    expect(byTarget.get(CHAIN)).toBe(MAIN);
    expect(byTarget.get(OTHER)).toBe(OTHER);
    // Targetless typed_link marks stay NULL.
    store.apply(
      env(
        "object.update",
        {
          objectId: BLOCK,
          contentAst: [
            { type: "text", text: "a " },
            { type: "typed_link", verb: "cites", text: "mark", metadata: { candidateSpans: [] } },
          ],
        },
        1727200002000,
      ),
    );
    expect(edgeRows(store).some((r) => r.type === "typed_link" && r.resolved_target_id === null)).toBe(true);
    store.close();
  });

  it("re-resolves on alias writes: re-point and clear move every chain member's edges", () => {
    const store = makeStore();
    seedWorld(store);
    // Re-point ALIAS at OTHER: both the ALIAS edge and the CHAIN edge (whose
    // chain now runs CHAIN -> ALIAS -> OTHER) follow.
    store.apply(env("object.update", { objectId: ALIAS, aliasedNodeId: OTHER }, 1727200002000));
    let byTarget = new Map(edgeRows(store).map((r) => [r.target_id, r.resolved_target_id]));
    expect(byTarget.get(ALIAS)).toBe(OTHER);
    expect(byTarget.get(CHAIN)).toBe(OTHER);
    // Clear ALIAS: its edges collapse to ALIAS itself; the CHAIN edge stops
    // at the cleared link (CHAIN -> ALIAS, terminal).
    store.apply(env("object.update", { objectId: ALIAS, aliasedNodeId: null }, 1727200003000));
    byTarget = new Map(edgeRows(store).map((r) => [r.target_id, r.resolved_target_id]));
    expect(byTarget.get(ALIAS)).toBe(ALIAS);
    expect(byTarget.get(CHAIN)).toBe(ALIAS);
    store.close();
  });

  it("a stale-HLC alias update loses the row LWW and re-resolves nothing", () => {
    const store = makeStore();
    seedWorld(store);
    store.apply(env("object.update", { objectId: ALIAS, aliasedNodeId: OTHER }, 1727200000500));
    expect(store.getNode(ALIAS)?.aliased_node_id).toBe(MAIN);
    const byTarget = new Map(edgeRows(store).map((r) => [r.target_id, r.resolved_target_id]));
    expect(byTarget.get(ALIAS)).toBe(MAIN);
    expect(byTarget.get(CHAIN)).toBe(MAIN);
    store.close();
  });

  it("trash / restore / permanent delete re-resolve the touching edges", () => {
    const store = makeStore();
    seedWorld(store);
    // Soft-delete the alias: inactive rows never resolve through — the
    // ALIAS edge stays on the alias (inert), the CHAIN edge collapses to
    // the last live link (ALIAS).
    store.apply(env("object.delete", { objectId: ALIAS }, 1727200002000));
    let byTarget = new Map(edgeRows(store).map((r) => [r.target_id, r.resolved_target_id]));
    expect(byTarget.get(ALIAS)).toBe(ALIAS);
    expect(byTarget.get(CHAIN)).toBe(ALIAS);
    // Restore heals the chains back to the terminal.
    store.apply(env("object.restore", { objectId: ALIAS }, 1727200003000));
    byTarget = new Map(edgeRows(store).map((r) => [r.target_id, r.resolved_target_id]));
    expect(byTarget.get(ALIAS)).toBe(MAIN);
    expect(byTarget.get(CHAIN)).toBe(MAIN);
    // Permanent delete: ghost rows resolve to the ghost id itself (the
    // walker's "unstored rows are their own terminal") — the edges survive
    // (PB1) but point nowhere live.
    store.apply(env("object.delete", { objectId: ALIAS, permanent: true }, 1727200004000));
    byTarget = new Map(edgeRows(store).map((r) => [r.target_id, r.resolved_target_id]));
    expect(byTarget.get(ALIAS)).toBe(ALIAS);
    expect(byTarget.get(CHAIN)).toBe(ALIAS);
    store.close();
  });

  it("wipe -> replay reproduces the materialized column byte-identically", () => {
    // One envelope set, deep-copied per application: envelope ids are minted
    // per newEnvelope call, so both stores must replay the SAME envelopes.
    const envelopes = worldEnvelopes();
    const store1 = makeStore();
    store1.applyMany(envelopes.map((e) => JSON.parse(JSON.stringify(e)) as Envelope));
    const before = edgeRows(store1);
    expect(before.some((r) => r.resolved_target_id === MAIN)).toBe(true);
    const replay = makeStore();
    replay.applyMany(envelopes.map((e) => JSON.parse(JSON.stringify(e)) as Envelope));
    expect(edgeRows(replay)).toEqual(before);
    // The full-database dump (the convergence gate's comparison shape)
    // agrees as well.
    expect(dumpDb(replay, { withAppliedLog: true })).toEqual(dumpDb(store1, { withAppliedLog: true }));
    store1.close();
    replay.close();
  });
});

describe.each(adapters)("$name: edge created_at — first-appearance stamps", ({ makeBackend }) => {
  const SRC = "0192a000-0000-7000-8000-0000000005c1";
  const TGT = "0192a000-0000-7000-8000-0000000005c2";
  const OTHER = "0192a000-0000-7000-8000-0000000005c3";
  const BLOCK = "0192a000-0000-7000-8000-0000000005c4";
  const REF_SCHEMA = "0192a000-0000-7000-8000-0000000005c5";
  const ELEM = "0192a000-0000-7000-8000-0000000005c6";

  function makeStore(): Store {
    return Store.open(makeBackend());
  }

  function seed(store: Store): void {
    store.applyMany([
      createPage(SRC, 1727200000000),
      createPage(TGT, 1727200000100),
      createPage(OTHER, 1727200000200),
      env("object.create", { objectId: BLOCK, parentId: SRC, isEmbedded: true }, 1727200000300),
    ]);
  }

  const mentionStamp = (store: Store): string | null =>
    (
      store.database
        .prepare("SELECT created_at FROM edge WHERE source_id = ? AND type = 'mention'")
        .get(BLOCK) as { created_at: string | null } | undefined
    )?.created_at ?? null;

  it("a re-derived content edge keeps its earliest stamp", () => {
    const store = makeStore();
    seed(store);
    store.apply(
      env(
        "object.update",
        { objectId: BLOCK, contentAst: [{ type: "mention", targetNodeId: TGT, text: "t" }] },
        1727200000400,
      ),
    );
    const first = new Date(1727200000400).toISOString();
    expect(mentionStamp(store)).toBe(first);
    // A later content write re-derives the identical (content-addressed) edge
    // id; the conflict path must keep the FIRST-appearance stamp.
    store.apply(
      env(
        "object.update",
        {
          objectId: BLOCK,
          contentAst: [
            { type: "text", text: "more " },
            { type: "mention", targetNodeId: TGT, text: "t" },
          ],
        },
        1727200005000,
      ),
    );
    expect(mentionStamp(store)).toBe(first);
    store.close();
  });

  it("a NULL legacy stamp never wins: re-derivation replaces it with the real stamp", () => {
    const store = makeStore();
    seed(store);
    store.apply(
      env(
        "object.update",
        { objectId: BLOCK, contentAst: [{ type: "mention", targetNodeId: TGT, text: "t" }] },
        1727200000400,
      ),
    );
    // Simulate a pre-stamp-era row (the property-edge NULL era): the edge
    // exists with no stamp. A later rebuild derives the same row id with a
    // real stamp — MIN(NULL, stamp) is NULL, so COALESCE must pick it up.
    store.database.prepare("UPDATE edge SET created_at = NULL WHERE source_id = ?").run(BLOCK);
    expect(mentionStamp(store)).toBeNull();
    store.apply(
      env(
        "object.update",
        {
          objectId: BLOCK,
          contentAst: [
            { type: "text", text: "more " },
            { type: "mention", targetNodeId: TGT, text: "t" },
          ],
        },
        1727200005000,
      ),
    );
    expect(mentionStamp(store)).toBe(new Date(1727200005000).toISOString());
    store.close();
  });

  it("property edges carry the value row's causal stamp, stable across re-derivation", () => {
    const store = makeStore();
    seed(store);
    store.apply(
      env(
        "propertySchema.create",
        { propertySchemaId: REF_SCHEMA, name: "ref", type: "object" },
        1727200000350,
      ),
    );
    store.apply(
      env(
        "property.set",
        { objectId: SRC, propertySchemaId: REF_SCHEMA, value: { nodeId: OTHER }, elementId: ELEM, idx: 0 },
        1727200000400,
      ),
    );
    const propStamp = (): string | null =>
      (
        store.database
          .prepare("SELECT created_at FROM edge WHERE source_id = ? AND type = 'property'")
          .get(SRC) as { created_at: string | null } | undefined
      )?.created_at ?? null;
    // The hlc_physical ms wall clock of the property.set op, in the envelope
    // ISO shape — NOT the later content-rebuild envelope's timestamp.
    expect(propStamp()).toBe(new Date(1727200000400).toISOString());
    store.apply(
      env(
        "object.update",
        { objectId: BLOCK, contentAst: [{ type: "text", text: "edit" }] },
        1727200005000,
      ),
    );
    expect(propStamp()).toBe(new Date(1727200000400).toISOString());
    store.close();
  });

  it("wipe -> replay converges the stamps across independent-write orders", () => {
    const creates = [
      createPage(SRC, 1727200000000),
      createPage(TGT, 1727200000100),
      createPage(OTHER, 1727200000200),
      env("object.create", { objectId: BLOCK, parentId: SRC, isEmbedded: true }, 1727200000300),
      env(
        "propertySchema.create",
        { propertySchemaId: REF_SCHEMA, name: "ref", type: "object" },
        1727200000350,
      ),
    ];
    const contentWrite = env(
      "object.update",
      { objectId: BLOCK, contentAst: [{ type: "mention", targetNodeId: TGT, text: "t" }] },
      1727200000400,
    );
    const propertyWrite = env(
      "property.set",
      { objectId: SRC, propertySchemaId: REF_SCHEMA, value: { nodeId: OTHER }, elementId: ELEM, idx: 0 },
      1727200000450,
    );
    const stamps = (store: Store) =>
      store.database
        .prepare("SELECT type, target_id, created_at FROM edge ORDER BY type, target_id")
        .all();
    const first = makeStore();
    first.applyMany([...creates.map((e) => JSON.parse(JSON.stringify(e)) as Envelope), contentWrite, propertyWrite]);
    const second = makeStore();
    second.applyMany([...creates.map((e) => JSON.parse(JSON.stringify(e)) as Envelope), propertyWrite, contentWrite]);
    // The property stamp rides the value row's hlc in BOTH orders (the later
    // content rebuild re-derives it with the same deterministic stamp), and
    // the mention stamp rides its own applying envelope.
    expect(stamps(second)).toEqual(stamps(first));
    expect(stamps(first).map((r) => (r as { created_at: string | null }).created_at)).toEqual([
      new Date(1727200000400).toISOString(), // mention (mention < property by type)
      new Date(1727200000450).toISOString(), // property
    ]);
    first.close();
    second.close();
  });
});

describe.each(adapters)("$name: v16 -> v17 migration (resolved_target_id backfill)", ({ makeBackend }) => {
  const MAIN = "0192a000-0000-7000-8000-0000000005b1";
  const ALIAS = "0192a000-0000-7000-8000-0000000005b2";
  const SOURCE = "0192a000-0000-7000-8000-0000000005b3";
  const BLOCK = "0192a000-0000-7000-8000-0000000005b4";

  const envelopes = (): Envelope[] => [
    createPage(MAIN, 1727200000000),
    createPage(ALIAS, 1727200000100),
    createPage(SOURCE, 1727200000200),
    env("object.create", { objectId: BLOCK, parentId: SOURCE, isEmbedded: true }, 1727200000300),
    env(
      "object.update",
      {
        objectId: BLOCK,
        contentAst: [{ type: "text", text: "see " }, { type: "mention", targetNodeId: ALIAS, text: "A" }],
      },
      1727200000400,
    ),
    env("object.update", { objectId: ALIAS, aliasedNodeId: MAIN }, 1727200000500),
  ];

  const edgeRows = (store: Store) =>
    store.database
      .prepare("SELECT source_id, target_id, resolved_target_id, type FROM edge ORDER BY id")
      .all() as Array<{ source_id: string; target_id: string | null; resolved_target_id: string | null; type: string }>;

  it("adds the column + index and backfills through the applier's resolution walk", () => {
    const store = Store.open(makeBackend());
    store.applyMany(envelopes());
    const expected = edgeRows(store);
    expect(expected.some((r) => r.resolved_target_id === MAIN)).toBe(true);

    // Simulate a pre-v17 database: drop the index + column and rewind the
    // version.
    store.database.exec(`
      DROP INDEX IF EXISTS idx_edge_resolved_target;
      ALTER TABLE edge DROP COLUMN resolved_target_id;
    `);
    store.database.pragma("user_version = 16");
    migrate(store.database, "fts5");
    expect(store.database.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    const columns = store.database.prepare("PRAGMA table_info(edge)").all() as { name: string }[];
    expect(columns.some((c) => c.name === "resolved_target_id")).toBe(true);
    const indexes = store.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_edge%'")
      .all() as { name: string }[];
    expect(indexes.map((r) => r.name)).toContain("idx_edge_resolved_target");
    // The backfill reproduces the applier-materialized values exactly.
    expect(edgeRows(store)).toEqual(expected);

    // Idempotent: a second migrate is a no-op that stays current.
    migrate(store.database, "fts5");
    expect(store.database.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(edgeRows(store)).toEqual(expected);
    store.close();
  });

  it("a migrated database equals a fresh v17 replay (wipe -> replay convergence)", () => {
    const migrated = Store.open(makeBackend());
    migrated.applyMany(envelopes());
    migrated.database.exec(`
      DROP INDEX IF EXISTS idx_edge_resolved_target;
      ALTER TABLE edge DROP COLUMN resolved_target_id;
    `);
    migrated.database.pragma("user_version = 16");
    migrate(migrated.database, "fts5");

    const fresh = Store.open(makeBackend());
    fresh.applyMany(envelopes());
    expect(edgeRows(migrated)).toEqual(edgeRows(fresh));
    migrated.close();
    fresh.close();
  });
});

// --- v18: the page-subtitle wire node field (description) --------------------------

describe.each(adapters)("$name: v18 — description wire node field", ({ makeBackend }) => {
  const PAGE = "0192a000-0000-7000-8000-00000000052a";

  function makeStore(): Store {
    return Store.open(makeBackend());
  }

  it("absence preserves, present-null clears, and the field rides the row LWW", () => {
    const store = makeStore();
    store.apply(createPage(PAGE, 1727200000000));
    expect(store.getNode(PAGE)?.description).toBeNull();
    store.apply(env("object.update", { objectId: PAGE, description: "Subtitle text" }, 1727200001000));
    expect(store.getNode(PAGE)?.description).toBe("Subtitle text");
    // An absent field is not a write: an icon-only update keeps the subtitle.
    store.apply(env("object.update", { objectId: PAGE, icon: "mdiStar" }, 1727200002000));
    expect(store.getNode(PAGE)).toMatchObject({ icon: "mdiStar", description: "Subtitle text" });
    // A stale-HLC update loses the row LWW race: nothing changes.
    store.apply(env("object.update", { objectId: PAGE, description: null }, 1727200000500));
    expect(store.getNode(PAGE)?.description).toBe("Subtitle text");
    // The winning clear.
    store.apply(env("object.update", { objectId: PAGE, description: null }, 1727200003000));
    expect(store.getNode(PAGE)?.description).toBeNull();
    store.close();
  });

  it("adds the column idempotently when a v17 database migrates", () => {
    const store = makeStore();
    store.apply(createPage(PAGE, 1727200000000));
    // Simulate a pre-v18 database: rewind the version and drop the column
    // (SQLite 3.35+ DROP COLUMN; the v16 index-precedent shape).
    store.database.exec("ALTER TABLE node DROP COLUMN description;");
    store.database.pragma("user_version = 17");
    migrate(store.database, "fts5");
    expect(store.database.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(store.getNode(PAGE)?.description).toBeNull();
    // Idempotent: a second migrate is a no-op that stays current.
    migrate(store.database, "fts5");
    expect(store.database.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    // The migrated table still maps the field on update.
    store.apply(env("object.update", { objectId: PAGE, description: "After migration" }, 1727200001000));
    expect(store.getNode(PAGE)?.description).toBe("After migration");
    store.close();
  });
});

// --- v23: the per-block list style (listStyle) --------------------------------

describe.each(adapters)("$name: v23 — listStyle wire node field", ({ makeBackend }) => {
  const PAGE = "0192a000-0000-7000-8000-00000000056a";
  const BLOCK = "0192a000-0000-7000-8000-00000000056b";

  function makeStore(): Store {
    return Store.open(makeBackend());
  }

  it("the fixture lands create-with-style, set, and null-clear", () => {
    const store = makeStore();
    const [createPage_, createBlock, setAlpha, clear, setRoman] = loadFixture("object-list-style.json");
    store.apply(createPage_!);
    store.apply(createBlock!);
    expect(store.getNode(BLOCK)?.list_style).toBe("numbered");
    store.apply(setAlpha!);
    expect(store.getNode(BLOCK)?.list_style).toBe("alpha");
    store.apply(clear!);
    expect(store.getNode(BLOCK)?.list_style).toBeNull();
    store.apply(setRoman!);
    expect(store.getNode(PAGE)?.list_style).toBe("roman");
    store.close();
  });

  it("absence preserves, present-null clears, and the field rides the row LWW", () => {
    const store = makeStore();
    store.apply(createPage(PAGE, 1727200000000));
    expect(store.getNode(PAGE)?.list_style).toBeNull();
    store.apply(env("object.update", { objectId: PAGE, listStyle: "numbered" }, 1727200001000));
    expect(store.getNode(PAGE)?.list_style).toBe("numbered");
    // An absent field is not a write: an icon-only update keeps the style.
    store.apply(env("object.update", { objectId: PAGE, icon: "mdiStar" }, 1727200002000));
    expect(store.getNode(PAGE)).toMatchObject({ icon: "mdiStar", list_style: "numbered" });
    // A stale-HLC update loses the row LWW race: nothing changes.
    store.apply(env("object.update", { objectId: PAGE, listStyle: null }, 1727200000500));
    expect(store.getNode(PAGE)?.list_style).toBe("numbered");
    // The winning clear.
    store.apply(env("object.update", { objectId: PAGE, listStyle: null }, 1727200003000));
    expect(store.getNode(PAGE)?.list_style).toBeNull();
    store.close();
  });

  it("adds the column idempotently when a v22 database migrates", () => {
    const store = makeStore();
    store.apply(createPage(PAGE, 1727200000000));
    // Simulate a pre-v23 database: rewind the version and drop the column
    // (the v18 description precedent).
    store.database.exec("ALTER TABLE node DROP COLUMN list_style;");
    store.database.pragma("user_version = 22");
    migrate(store.database, "fts5");
    expect(store.database.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(store.getNode(PAGE)?.list_style).toBeNull();
    // Idempotent: a second migrate is a no-op that stays current.
    migrate(store.database, "fts5");
    expect(store.database.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    // The migrated table still maps the field on update.
    store.apply(env("object.update", { objectId: PAGE, listStyle: "alpha" }, 1727200001000));
    expect(store.getNode(PAGE)?.list_style).toBe("alpha");
    store.close();
  });
});

describe.each(adapters)("$name: backlinksWithRollup — the alias family rides resolved_target_id", ({ makeBackend }) => {
  const MAIN = "0192a000-0000-7000-8000-0000000005c1";
  const ALIAS = "0192a000-0000-7000-8000-0000000005c2";
  const OTHER = "0192a000-0000-7000-8000-0000000005c3";
  const BLOCK_CARRIER = "0192a000-0000-7000-8000-0000000005c4";
  const SRC_MAIN = "0192a000-0000-7000-8000-0000000005c6";
  const SRC_ALIAS = "0192a000-0000-7000-8000-0000000005c7";
  const SRC_BLOCK = "0192a000-0000-7000-8000-0000000005c8";
  const CARRIER_BLOCK = "0192a000-0000-7000-8000-0000000005c9";
  const INNER_BLOCK = "0192a000-0000-7000-8000-0000000005ca";
  const SELF_BLOCK = "0192a000-0000-7000-8000-0000000005cb";

  const mentionOn = (blockId: string, parentId: string, target: string, physical: number): Envelope[] => [
    env("object.create", { objectId: blockId, parentId, isEmbedded: true }, physical),
    env(
      "object.update",
      {
        objectId: blockId,
        contentAst: [{ type: "text", text: "see " }, { type: "mention", targetNodeId: target, text: "x" }],
      },
      physical + 1,
    ),
  ];

  function makeStore(): Store {
    const store = Store.open(makeBackend());
    store.applyMany([
      createPage(MAIN, 1727200000000),
      createPage(ALIAS, 1727200000100),
      createPage(OTHER, 1727200000200),
      createPage(SRC_MAIN, 1727200000500),
      createPage(SRC_ALIAS, 1727200000600),
      createPage(SRC_BLOCK, 1727200000700),
      env("object.create", { objectId: BLOCK_CARRIER, parentId: SRC_BLOCK, isEmbedded: true }, 1727200000800),
      env("object.update", { objectId: ALIAS, aliasedNodeId: MAIN }, 1727200000900),
      // A block carrier: the field rides a non-page node — it must NOT act
      // as an alias (the page restriction, mirrored into the read).
      env("object.update", { objectId: BLOCK_CARRIER, aliasedNodeId: MAIN }, 1727200001000),
      ...mentionOn("0192a000-0000-7000-8000-0000000005d1", SRC_MAIN, MAIN, 1727200002000),
      ...mentionOn("0192a000-0000-7000-8000-0000000005d2", SRC_ALIAS, ALIAS, 1727200003000),
      ...mentionOn("0192a000-0000-7000-8000-0000000005d3", SRC_BLOCK, BLOCK_CARRIER, 1727200004000),
    ]);
    return store;
  }

  const kindsOf = (store: Store, id: string) =>
    (store.backlinksWithRollup(id) as Array<{ source_id: string; kind: string; target_id: string | null }>).map(
      (r) => ({ source: r.source_id, kind: r.kind, target: r.target_id }),
    );

  it("labels direct, alias, and non-acting block-carrier edges; the alias view stays raw-direct", () => {
    const store = makeStore();
    const mainRows = kindsOf(store, MAIN);
    // The edge authored at the main page is direct; the edge authored at the
    // alias rolls up as alias (raw target preserved on the row); the
    // block-carrier edge never lands on the main (page restriction).
    expect(mainRows).toContainEqual({ source: "0192a000-0000-7000-8000-0000000005d1", kind: "direct", target: MAIN });
    expect(mainRows).toContainEqual({ source: "0192a000-0000-7000-8000-0000000005d2", kind: "alias", target: ALIAS });
    expect(mainRows.some((r) => r.source === "0192a000-0000-7000-8000-0000000005d3")).toBe(false);
    // The alias page's own view: its edge lists as direct (raw), the main
    // page's edge stays off it.
    const aliasRows = kindsOf(store, ALIAS);
    expect(aliasRows).toContainEqual({ source: "0192a000-0000-7000-8000-0000000005d2", kind: "direct", target: ALIAS });
    expect(aliasRows.some((r) => r.target === MAIN)).toBe(false);
    // The block carrier's own view lists its edge (raw-direct).
    const carrierRows = kindsOf(store, BLOCK_CARRIER);
    expect(carrierRows).toContainEqual({
      source: "0192a000-0000-7000-8000-0000000005d3",
      kind: "direct",
      target: BLOCK_CARRIER,
    });
    store.close();
  });

  it("a trashed alias drops out of the roll-up and heals on restore", () => {
    const store = makeStore();
    expect(kindsOf(store, MAIN).some((r) => r.kind === "alias")).toBe(true);
    store.apply(env("object.delete", { objectId: ALIAS }, 1727200005000));
    expect(kindsOf(store, MAIN).some((r) => r.kind === "alias")).toBe(false);
    store.apply(env("object.restore", { objectId: ALIAS }, 1727200006000));
    expect(kindsOf(store, MAIN).some((r) => r.kind === "alias")).toBe(true);
    store.close();
  });

  it("containment still works on resolved targets: an outward link from inside the subtree", () => {
    const store = makeStore();
    // A block INSIDE MAIN's subtree links OUT (to OTHER): containment.
    store.applyMany(mentionOn(INNER_BLOCK, MAIN, OTHER, 1727200007000));
    const rows = store.backlinksWithRollup(MAIN) as Array<{ source_id: string; kind: string; distance: number }>;
    const containment = rows.find((r) => r.source_id === INNER_BLOCK);
    expect(containment).toMatchObject({ kind: "containment", distance: 1 });
    // An intra-subtree link (target = MAIN itself) is direct, not containment.
    store.applyMany(mentionOn(SELF_BLOCK, MAIN, MAIN, 1727200008000));
    const innerMain = (store.backlinksWithRollup(MAIN) as Array<{ source_id: string; kind: string }>).find(
      (r) => r.source_id === SELF_BLOCK,
    );
    expect(innerMain?.kind).toBe("direct");
    store.close();
  });
});

// --- class.create on an existing node: the declaration/conversion capability --------

describe.each(adapters)("$name: class.create conversion (M47)", ({ makeBackend }) => {
  const PAGE = "0192a000-0000-7000-8000-00000000053a";
  const RACK = "0192a000-0000-7000-8000-00000000053b";
  const SHELF = "0192a000-0000-7000-8000-00000000053c";
  const FRESH = "0192a000-0000-7000-8000-00000000053d";

  function makeStore(): Store {
    return Store.open(makeBackend());
  }

  it("declares an existing parentless page a class: identity flips, the title rides along", () => {
    const store = makeStore();
    const [pageCreate, , shelfCreate, convertPage] = loadFixture("class-convert.json");
    store.apply(pageCreate!);
    store.apply(convertPage!);
    const row = store.getNode(PAGE);
    expect(row).toMatchObject({
      is_class: 1,
      is_embedded: 0,
      parent_id: null,
    });
    // Title-is-content: the node's existing text content is the class title
    // (the conversion payload carried no contentAst).
    expect(JSON.parse(row!.content)).toEqual([{ type: "text", text: "Genre collection" }]);
    // The registry row + hierarchy self-row landed.
    expect(
      (store.database.prepare("SELECT name, active FROM class WHERE id = ?").get(PAGE) as {
        name: string;
        active: number;
      }).name,
    ).toBe("Genre collection");
    expect(
      store.database
        .prepare("SELECT 1 FROM class_hierarchy WHERE class_id = ? AND ancestor_id = ?")
        .get(PAGE, PAGE),
    ).toBeDefined();
    // The class answers class-identity reads.
    expect(
      (
        store.database
          .prepare("SELECT is_class FROM node WHERE id = ?")
          .get(PAGE) as { is_class: number }
      ).is_class,
    ).toBe(1);
    store.close();
  });

  it("converting a PARENTED node cuts it to a root: the parent edge and its child-order row go", () => {
    const store = makeStore();
    const [, rackCreate, shelfCreate, , convertShelf] = loadFixture("class-convert.json");
    store.apply(rackCreate!);
    store.apply(shelfCreate!);
    expect(store.children(RACK).map((n) => n.id)).toEqual([SHELF]);
    store.apply(convertShelf!);
    expect(store.getNode(SHELF)).toMatchObject({ is_class: 1, parent_id: null });
    expect(store.children(RACK)).toEqual([]);
    expect(
      store.database
        .prepare("SELECT 1 FROM node_child_order WHERE child_id = ?")
        .get(SHELF),
    ).toBeUndefined();
    store.close();
  });

  it("re-declaration is a replace no-op and fresh declaration keeps working", () => {
    const store = makeStore();
    const [pageCreate, , , convertPage, , redeclare, freshCreate] = loadFixture("class-convert.json");
    store.apply(pageCreate!);
    store.apply(convertPage!);
    const contentBefore = store.getNode(PAGE)?.content;
    store.apply(redeclare!);
    expect(store.getNode(PAGE)?.content).toBe(contentBefore);
    // A fresh id still declares a brand-new class node.
    store.apply(freshCreate!);
    expect(store.getNode(FRESH)).toMatchObject({ is_class: 1 });
    expect(JSON.parse(store.getNode(FRESH)!.content)).toEqual([
      { type: "text", text: "Fresh genre" },
    ]);
    store.close();
  });
});

// --- M12: write-time alias-cycle validation + the resolveAlias chain walker --------

describe.each(adapters)("$name: alias cycles (M12)", ({ makeBackend }) => {
  const A = "0192a000-0000-7000-8000-0000000000a1";
  const B = "0192a000-0000-7000-8000-0000000000a2";
  const C = "0192a000-0000-7000-8000-0000000000a3";
  const D = "0192a000-0000-7000-8000-0000000000a4";

  function makeStore(): Store {
    return Store.open(makeBackend());
  }

  const alias = (from: string, to: string | null, physical: number) =>
    env("object.update", { objectId: from, aliasedNodeId: to }, physical);

  it("a plain chain sets and resolves; acyclic re-points stay legal", () => {
    const store = makeStore();
    for (const id of [A, B, C, D]) store.apply(createPage(id, 1727200000000));
    store.apply(alias(A, B, 1727200001000));
    store.apply(alias(B, C, 1727200002000));
    expect(store.getNode(A)?.aliased_node_id).toBe(B);
    expect(store.resolveAlias(A)).toBe(C);
    expect(store.resolveAlias(B)).toBe(C);
    expect(store.resolveAlias(C)).toBe(C);
    // Re-pointing the middle of the chain is fine while it stays acyclic:
    // B → D (D carries no alias) collapses A's chain to D as well.
    store.apply(alias(B, D, 1727200003000));
    expect(store.resolveAlias(A)).toBe(D);
    expect(store.resolveAlias(B)).toBe(D);
    store.close();
  });

  it("self-alias (the 1-edge cycle) fails loud and is never applied", () => {
    const store = makeStore();
    store.apply(createPage(A, 1727200000000));
    expect(() => store.apply(alias(A, A, 1727200001000))).toThrow(CycleError);
    expect(store.getNode(A)?.aliased_node_id).toBeNull();
    store.close();
  });

  it("an indirect cycle fails loud: A→B→C then C→A is rejected and nothing changes", () => {
    const store = makeStore();
    for (const id of [A, B, C]) store.apply(createPage(id, 1727200000000));
    store.apply(alias(A, B, 1727200001000));
    store.apply(alias(B, C, 1727200002000));
    // C → A would close A → B → C → A: rejected, never applied.
    expect(() => store.apply(alias(C, A, 1727200003000))).toThrow(CycleError);
    expect(store.getNode(C)?.aliased_node_id).toBeNull();
    expect(store.getNode(A)?.aliased_node_id).toBe(B);
    expect(store.getNode(B)?.aliased_node_id).toBe(C);
    // Same for a 2-cycle proposal: B → A revisits A's chain back to B.
    expect(() => store.apply(alias(B, A, 1727200004000))).toThrow(CycleError);
    expect(store.getNode(B)?.aliased_node_id).toBe(C);
    store.close();
  });

  it("clearing an alias lands NULL and re-opens the chain for new targets", () => {
    const store = makeStore();
    for (const id of [A, B]) store.apply(createPage(id, 1727200000000));
    store.apply(alias(A, B, 1727200001000));
    expect(store.resolveAlias(A)).toBe(B);
    // Clearing cannot create a cycle — it never touches the check and lands.
    store.apply(alias(A, null, 1727200002000));
    expect(store.getNode(A)?.aliased_node_id).toBeNull();
    expect(store.resolveAlias(A)).toBe(A);
    // With A's alias gone, B → A is acyclic and legal.
    store.apply(alias(B, A, 1727200003000));
    expect(store.resolveAlias(B)).toBe(A);
    store.close();
  });

  it("a stale-HLC alias write is dropped by the row LWW before any check", () => {
    const store = makeStore();
    for (const id of [A, B, C]) store.apply(createPage(id, 1727200000000));
    store.apply(alias(A, B, 1727200001000));
    store.apply(alias(B, C, 1727200002000));
    // Older than both rows — dropped silently (LWW), no throw, no change.
    store.apply(alias(A, C, 1727200000500));
    expect(store.getNode(A)?.aliased_node_id).toBe(B);
    store.close();
  });

  it("resolveAlias is cycle-safe (id unchanged on a revisit) and depth-capped", () => {
    const store = makeStore();
    for (const id of [A, B, C]) store.apply(createPage(id, 1727200000000));
    store.apply(alias(A, B, 1727200001000));
    store.apply(alias(B, C, 1727200002000));
    expect(store.resolveAlias(A)).toBe(C);
    // A cycle can only exist if it predates the write-path check (a legacy
    // row, a hand-edited store): close C → A in place and observe the
    // walker's ruling — every member's walk revisits its start and yields
    // the STARTING id unchanged.
    store.database
      .prepare("UPDATE node SET aliased_node_id = ? WHERE id = ?")
      .run(A, C);
    expect(store.resolveAlias(A)).toBe(A);
    expect(store.resolveAlias(B)).toBe(B);
    expect(store.resolveAlias(C)).toBe(C);
    // Depth cap: a hand-built 40-link chain resolves to the node reached at
    // the cap (best-effort terminal), never loops forever.
    let prev = A;
    for (let i = 0; i < 40; i += 1) {
      const next = `0192a000-0000-7000-8000-0000000001${String(i).padStart(2, "0")}`;
      store.apply(createPage(next, 1727200010000 + i));
      store.apply(alias(prev, next, 1727200020000 + i));
      prev = next;
    }
    const resolved = store.resolveAlias(A);
    expect(resolved).not.toBe(A);
    store.close();
  });
});

// --- M38: the `asset` property type -------------------------------------------------

describe.each(adapters)("$name: asset property type (M38)", ({ makeBackend }) => {
  const ASSET_CLASS = "00000000-0000-0000-0001-000000000009";
  const SCHEMA = "0192a000-0000-7000-8000-000000000541";
  const ATTACHMENTS = "00000000-0000-0000-0000-000000000011";
  const PAGE = "0192a000-0000-7000-8000-0000000000f1";
  const ASSET_NODE = "0192a000-0000-7000-8000-0000000000f2";
  const PLAIN_NODE = "0192a000-0000-7000-8000-0000000000f3";
  const SOURCE_CLASS = "00000000-0000-0000-0001-000000000023";

  function makeStore(): Store {
    return Store.open(makeBackend());
  }

  function worldWithAssetClass(): Store {
    const store = makeStore();
    store.apply(
      env(
        "class.create",
        { classId: ASSET_CLASS, contentAst: [{ type: "text", text: "Asset" }] },
        1727199999000,
      ),
    );
    // The page carries the source class: the class-scoped schemas below
    // (scopeClassIds is the sole locality authority, owner ruling
    // 2026-10-20) require it for property.set eligibility.
    store.apply(
      env(
        "object.create",
        { objectId: PAGE, isEmbedded: false, classIds: [SOURCE_CLASS] },
        1727200000000,
      ),
    );
    store.apply(
      env(
        "object.create",
        { objectId: ASSET_NODE, isEmbedded: false, classIds: [ASSET_CLASS] },
        1727200000100,
      ),
    );
    store.apply(createPage(PLAIN_NODE, 1727200000200));
    return store;
  }

  it("the fixture lands asset-typed schemas and the update coexists", () => {
    const store = makeStore();
    store.applyMany(loadFixture("property-asset-type.json"));
    const rows = store.database
      .prepare("SELECT id, type, multi, scope_class_ids, name FROM property_schema ORDER BY id")
      .all() as Array<{ id: string; type: string; multi: number; scope_class_ids: string | null; name: string }>;
    expect(rows).toEqual([
      {
        id: "0192a000-0000-7000-8000-000000000541",
        type: "asset",
        multi: 1,
        // Scoped to the source class (the sole locality authority, owner
        // ruling 2026-10-20) — the retired "class" scope's one-element case.
        scope_class_ids: JSON.stringify([SOURCE_CLASS]),
        name: "Attachment",
      },
      {
        id: "0192a000-0000-7000-8000-000000000542",
        type: "asset",
        multi: 0,
        // The retired "object" scope had no consumer — it converges to global.
        scope_class_ids: null,
        name: "Cover file (renamed)",
      },
    ]);
    store.close();
  });

  it("values validate as asset-node references — the implicit filter is the asset class", () => {
    const store = worldWithAssetClass();
    store.applyMany([
      env(
        "propertySchema.create",
        { propertySchemaId: SCHEMA, name: "Attachment", type: "asset", multi: true, scopeClassIds: [SOURCE_CLASS] },
        1727200001000,
      ),
      env("class.property.set", { classId: SOURCE_CLASS, propertySchemaId: SCHEMA }, 1727200001100),
      // A legacy bare-uuid carrier normalizes to {nodeId}.
      env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA, value: ASSET_NODE }, 1727200001200),
    ]);
    const row = store.database
      .prepare("SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ?")
      .get(PAGE, SCHEMA) as { value: string };
    expect(JSON.parse(row.value)).toEqual({ nodeId: ASSET_NODE });

    // A target NOT carrying the asset class fails loud (implicit filter)…
    expect(() =>
      store.apply(
        env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA, value: { nodeId: PLAIN_NODE } }, 1727200001300),
      ),
    ).toThrow(/does not carry any of the schema's allowed classes/);
    // …as does a nonexistent node…
    expect(() =>
      store.apply(
        env(
          "property.set",
          { objectId: PAGE, propertySchemaId: SCHEMA, value: { nodeId: "0192a000-0000-7000-8000-00000000ffff" } },
          1727200001400,
        ),
      ),
    ).toThrow(/does not exist/);
    // …and a non-reference shape fails the type's shape check.
    expect(() =>
      store.apply(
        env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA, value: "not-a-ref" }, 1727200001500),
      ),
    ).toThrow(PropertyValueShapeError);
    store.close();
  });

  it("node-typed defaults stay unsupported: a defaultValue on an asset schema fails loud", () => {
    const store = worldWithAssetClass();
    store.apply(
      env(
        "propertySchema.create",
        { propertySchemaId: SCHEMA, name: "Attachment", type: "asset", multi: true, scopeClassIds: [SOURCE_CLASS] },
        1727200001000,
      ),
    );
    expect(() =>
      store.apply(
        env(
          "propertySchema.update",
          { propertySchemaId: SCHEMA, defaultValue: { nodeId: ASSET_NODE } },
          1727200001100,
        ),
      ),
    ).toThrow(/must be null/);
    store.close();
  });

  it("the retype path: propertySchema.create upserts object → asset, drops the explicit filter, preserves values and flags", () => {
    const store = worldWithAssetClass();
    store.applyMany([
      // The pre-M38 seeded shape: object-typed with an explicit filter.
      env(
        "propertySchema.create",
        {
          propertySchemaId: ATTACHMENTS,
          name: "Attachments",
          type: "object",
          multi: true,
          scopeClassIds: [SOURCE_CLASS],
          targetClassFilter: [ASSET_CLASS],
        },
        1727200001000,
      ),
      env("class.property.set", { classId: SOURCE_CLASS, propertySchemaId: ATTACHMENTS }, 1727200001100),
      env("property.set", { objectId: PAGE, propertySchemaId: ATTACHMENTS, value: { nodeId: ASSET_NODE } }, 1727200001200),
      // A user-set render contract the retype must not clobber.
      env("propertySchema.update", { propertySchemaId: ATTACHMENTS, display: "inline" }, 1727200001300),
    ]);

    // The M38 migration envelope: same id, type "asset", NO explicit filter.
    store.apply(
      env(
        "propertySchema.create",
        {
          propertySchemaId: ATTACHMENTS,
          name: "Attachments",
          type: "asset",
          multi: true,
          scopeClassIds: [SOURCE_CLASS],
          options: [],
          display: "inline",
        },
        1727200002000,
      ),
    );

    const row = store.database
      .prepare("SELECT type, target_class_filter, display FROM property_schema WHERE id = ?")
      .get(ATTACHMENTS) as { type: string; target_class_filter: string | null; display: string | null };
    expect(row.type).toBe("asset");
    // The filter is implicit now — the explicit column retired.
    expect(row.target_class_filter).toBeNull();
    // The user-set display flag survived the upsert (carried by the payload).
    expect(row.display).toBe("inline");
    // Values are shape-compatible ({nodeId} → asset nodes): untouched.
    const value = store.database
      .prepare("SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ?")
      .get(PAGE, ATTACHMENTS) as { value: string };
    expect(JSON.parse(value.value)).toEqual({ nodeId: ASSET_NODE });
    // And the implicit filter now guards NEW writes.
    expect(() =>
      store.apply(
        env("property.set", { objectId: PAGE, propertySchemaId: ATTACHMENTS, value: { nodeId: PLAIN_NODE } }, 1727200003000),
      ),
    ).toThrow(/does not carry any of the schema's allowed classes/);
    store.close();
  });
});

// --- Property-schema scope (owner ruling 2026-10-20: scopeClassIds is the sole
// --- locality authority; R3 write-time enforcement, R4 read gating, R5
// --- dead-config rejection; update gains icon/scopeClassIds/targetClassFilter/
// --- multi/validationRules with keep/clear)

describe.each(adapters)("$name: property-schema scope + update fields", ({ makeBackend }) => {
  const CLASS_A = "0192a000-0000-7000-8000-000000000a01";
  const CLASS_B = "0192a000-0000-7000-8000-000000000a02";
  const SCHEMA = "0192a000-0000-7000-8000-000000000a10";
  const NODE_A = "0192a000-0000-7000-8000-000000000a21";
  const NODE_B = "0192a000-0000-7000-8000-000000000a22";
  const NODE_X = "0192a000-0000-7000-8000-000000000a23";

  function scopedWorld(store: Store): void {
    store.applyMany([
      env("class.create", { classId: CLASS_A, contentAst: [{ type: "text", "text": "A" }] }, 1727200001000),
      env("class.create", { classId: CLASS_B, contentAst: [{ type: "text", "text": "B" }] }, 1727200001100),
      env("class.setExtends", { classId: CLASS_B, parentClassIds: [CLASS_A] }, 1727200001200),
      env(
        "propertySchema.create",
        { propertySchemaId: SCHEMA, name: "Genre", type: "text", scopeClassIds: [CLASS_A] },
        1727200001300,
      ),
      env("object.create", { objectId: NODE_A, isEmbedded: false, classIds: [CLASS_A] }, 1727200001400),
      env("object.create", { objectId: NODE_B, isEmbedded: false, classIds: [CLASS_B] }, 1727200001500),
      env("object.create", { objectId: NODE_X, isEmbedded: false }, 1727200001600),
    ]);
  }

  it("the fixture pins extends-aware eligibility and survival under narrowing", () => {
    const store = Store.open(makeBackend());
    store.applyMany(loadFixture("property-schema-scope.json"));
    const A = "0192a000-0000-7000-8000-000000000901";
    const SCHEMA_ID = "0192a000-0000-7000-8000-000000000910";
    const NA = "0192a000-0000-7000-8000-000000000921";
    const NB = "0192a000-0000-7000-8000-000000000922";
    const NX = "0192a000-0000-7000-8000-000000000923";

    const rowsOf = (nodeId: string) =>
      store.getEffectiveProperties(nodeId).filter((row) => row.propertySchemaId === SCHEMA_ID);
    // The scope list rides the schema row; the icon rides too.
    const schemaRow = store.database
      .prepare("SELECT icon, scope_class_ids FROM property_schema WHERE id = ?")
      .get(SCHEMA_ID) as { icon: string | null; scope_class_ids: string | null };
    expect(schemaRow.icon).toBe("mdiTagOutline");
    expect(JSON.parse(schemaRow.scope_class_ids!)).toEqual([A]);
    // A-member and B-member (via the extends ancestor) are eligible.
    expect(rowsOf(NA).map((row) => [row.value, row.eligible])).toEqual([["science fiction", true]]);
    expect(rowsOf(NB).map((row) => [row.value, row.eligible])).toEqual([["hard sci-fi", true]]);
    // The unclassed node's authored row SURVIVES the narrowing (never
    // retroactive) and reads tagged eligible=false (R3 read-side arm).
    expect(rowsOf(NX).map((row) => [row.value, row.eligible])).toEqual([
      ["authored while global", false],
    ]);
    // The binding row authored while the schema was scoped to A survives too.
    expect(
      store.database
        .prepare("SELECT COUNT(*) AS n FROM class_property WHERE class_id = ? AND property_schema_id = ?")
        .get(A, SCHEMA_ID),
    ).toEqual({ n: 1 });
    store.close();
  });

  it("R3: property.set on an ineligible node fails loud; schema-less writes stay unchecked", () => {
    const store = Store.open(makeBackend());
    scopedWorld(store);
    expect(() =>
      store.apply(
        env("property.set", { objectId: NODE_X, propertySchemaId: SCHEMA, value: "nope", idx: 0 }, 1727200002000),
      ),
    ).toThrow(MoveGuardError);
    expect(() =>
      store.apply(
        env("property.set", { objectId: NODE_X, propertySchemaId: SCHEMA, value: "nope", idx: 0 }, 1727200002000),
      ),
    ).toThrow(/not eligible/);
    // An eligible node (own class) writes fine; an extends-aware node (the
    // subclass carries B; A is an ancestor) writes fine.
    store.apply(env("property.set", { objectId: NODE_A, propertySchemaId: SCHEMA, value: "a", idx: 0 }, 1727200002100));
    store.apply(env("property.set", { objectId: NODE_B, propertySchemaId: SCHEMA, value: "b", idx: 0 }, 1727200002200));
    // Unknown schema id: no schema row, no eligibility check (PG6 precedent).
    store.apply(
      env(
        "property.set",
        { objectId: NODE_X, propertySchemaId: "0192a000-0000-7000-8000-00000000beef", value: "free", idx: 0 },
        1727200002300,
      ),
    );
    store.close();
  });

  it("R5: class.property.set on a class outside the scope fails loud; a subclass-of-scope class binds fine", () => {
    const store = Store.open(makeBackend());
    scopedWorld(store);
    // A class with NO relation to the scope: dead config, rejected.
    const foreign = "0192a000-0000-7000-8000-000000000a30";
    store.apply(
      env("class.create", { classId: foreign, contentAst: [{ type: "text", "text": "Foreign" }] }, 1727200002000),
    );
    expect(() =>
      store.apply(
        env("class.property.set", { classId: foreign, propertySchemaId: SCHEMA }, 1727200002100),
      ),
    ).toThrow(MoveGuardError);
    expect(() =>
      store.apply(
        env("class.property.set", { classId: foreign, propertySchemaId: SCHEMA }, 1727200002100),
      ),
    ).toThrow(/would be inert/);
    // B extends A (in scope): the binding is live — it must be accepted.
    store.apply(
      env("class.property.set", { classId: CLASS_B, propertySchemaId: SCHEMA }, 1727200002200),
    );
    store.apply(
      env("propertySchema.update", { propertySchemaId: SCHEMA, defaultValue: "inherited" }, 1727200002250),
    );
    // R4 arm: NODE_X carries no scope class — B's binding with a default
    // derives NOTHING for it; NODE_B (via the A ancestor) reads the default.
    const rows = (nodeId: string) =>
      store.getEffectiveProperties(nodeId).filter((row) => row.propertySchemaId === SCHEMA);
    expect(rows(NODE_X).filter((row) => row.source === "default")).toHaveLength(0);
    expect(rows(NODE_B).some((row) => row.source === "default" && row.value === "inherited" && row.eligible)).toBe(true);
    store.close();
  });

  it("R4: an ineligible node reads neither the property nor a derived default", () => {
    const store = Store.open(makeBackend());
    scopedWorld(store);
    store.apply(
      env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA }, 1727200002000),
    );
    store.apply(
      env("propertySchema.update", { propertySchemaId: SCHEMA, defaultValue: "defaulted" }, 1727200002050),
    );
    const rows = (nodeId: string) =>
      store.getEffectiveProperties(nodeId).filter((row) => row.propertySchemaId === SCHEMA);
    // NODE_X: no authored rows, no derived default (the stray binding is inert).
    expect(rows(NODE_X)).toHaveLength(0);
    // NODE_A: the derived default materializes, eligible.
    expect(rows(NODE_A).map((row) => [row.source, row.value, row.eligible])).toEqual([
      ["default", "defaulted", true],
    ]);
    store.close();
  });

  it("the retired scope key fails loud at the envelope gate (create and update)", () => {
    const store = Store.open(makeBackend());
    for (const scope of ["global", "class", "object"]) {
      expect(() =>
        store.apply(
          env(
            "propertySchema.create",
            { propertySchemaId: SCHEMA, name: "x", type: "text", scope },
            1727200001000,
          ),
        ),
      ).toThrow(/invalid propertySchema\.create payload/);
    }
    expect(() =>
      store.apply(env("propertySchema.update", { propertySchemaId: SCHEMA, scope: "global" }, 1727200001000)),
    ).toThrow(/invalid propertySchema\.update payload/);
    // An empty scopeClassIds is likewise rejected at the gate.
    expect(() =>
      store.apply(
        env(
          "propertySchema.create",
          { propertySchemaId: SCHEMA, name: "x", type: "text", scopeClassIds: [] },
          1727200001000,
        ),
      ),
    ).toThrow(/invalid propertySchema\.create payload/);
    store.close();
  });

  it("update keep/clear for icon/scopeClassIds/targetClassFilter/multi/validationRules", () => {
    const store = Store.open(makeBackend());
    store.applyMany(loadFixture("property-schema-update-fields.json"));
    const row = () =>
      store.database
        .prepare(
          "SELECT icon, multi, scope_class_ids, target_class_filter, validation_rules FROM property_schema WHERE id = ?",
        )
        .get("0192a000-0000-7000-8000-000000000960") as {
        icon: string | null;
        multi: number;
        scope_class_ids: string | null;
        target_class_filter: string | null;
        validation_rules: string | null;
      };
    // Cleared at the end of the Score lifecycle: icon/multi/rules back to
    // defaults, the keep-riding name landed.
    expect(row()).toEqual({
      icon: null,
      multi: 0,
      scope_class_ids: null,
      target_class_filter: null,
      validation_rules: null,
    });
    expect(
      (
        store.database
          .prepare("SELECT name FROM property_schema WHERE id = ?")
          .get("0192a000-0000-7000-8000-000000000960") as { name: string }
      ).name,
    ).toBe("Score (kept fields ride)");
    // Related: filter + scope set then cleared.
    const related = store.database
      .prepare("SELECT scope_class_ids, target_class_filter FROM property_schema WHERE id = ?")
      .get("0192a000-0000-7000-8000-000000000961") as {
      scope_class_ids: string | null;
      target_class_filter: string | null;
    };
    expect(related).toEqual({ scope_class_ids: null, target_class_filter: null });
    store.close();
  });

  it("validationRules applicability is apply-time against the stored type", () => {
    const store = Store.open(makeBackend());
    const text = "0192a000-0000-7000-8000-000000000b10";
    const num = "0192a000-0000-7000-8000-000000000b11";
    const url = "0192a000-0000-7000-8000-000000000b12";
    store.applyMany([
      env("propertySchema.create", { propertySchemaId: text, name: "t", type: "text" }, 1727200001000),
      env("propertySchema.create", { propertySchemaId: num, name: "n", type: "number" }, 1727200001100),
      env("propertySchema.create", { propertySchemaId: url, name: "u", type: "url" }, 1727200001200),
    ]);
    // min/max on a text schema: fail loud.
    expect(() =>
      store.apply(env("propertySchema.update", { propertySchemaId: text, validationRules: { min: 0 } }, 1727200002000)),
    ).toThrow(/min\/max apply to number schemas only/);
    expect(() =>
      store.apply(env("propertySchema.update", { propertySchemaId: text, validationRules: { max: 5 } }, 1727200002100)),
    ).toThrow(/min\/max apply to number schemas only/);
    // pattern on a number schema: fail loud.
    expect(() =>
      store.apply(env("propertySchema.update", { propertySchemaId: num, validationRules: { pattern: "^a" } }, 1727200002200)),
    ).toThrow(/pattern applies to text\/url\/email schemas only/);
    // Legal arms: min/max on number, pattern on text and url.
    store.apply(env("propertySchema.update", { propertySchemaId: num, validationRules: { min: 0, max: 10 } }, 1727200002300));
    store.apply(env("propertySchema.update", { propertySchemaId: text, validationRules: { pattern: "^#" } }, 1727200002400));
    store.apply(env("propertySchema.update", { propertySchemaId: url, validationRules: { pattern: "^https://" } }, 1727200002500));
    // min > max fails at the payload gate.
    expect(() =>
      store.apply(env("propertySchema.update", { propertySchemaId: num, validationRules: { min: 5, max: 1 } }, 1727200002600)),
    ).toThrow(/invalid propertySchema\.update payload/);
    const rulesOf = (id: string) =>
      (store.database.prepare("SELECT validation_rules FROM property_schema WHERE id = ?").get(id) as {
        validation_rules: string | null;
      }).validation_rules;
    expect(JSON.parse(rulesOf(num)!)).toEqual({ min: 0, max: 10 });
    expect(JSON.parse(rulesOf(text)!)).toEqual({ pattern: "^#" });
    expect(JSON.parse(rulesOf(url)!)).toEqual({ pattern: "^https://" });
    // Null clears.
    store.apply(env("propertySchema.update", { propertySchemaId: num, validationRules: null }, 1727200002700));
    expect(rulesOf(num)).toBeNull();
    store.close();
  });
});

// --- v28: the class-registry ghost-row scrub -----------------------------------

describe.each(adapters)("$name: v28 — registry rows deactivated when no live class node backs them", ({ makeBackend }) => {
  const LIVE = "0192a000-0000-7000-8000-000000000b20";
  const ARCHIVED = "0192a000-0000-7000-8000-000000000b21";
  const PURGED = "0192a000-0000-7000-8000-000000000b22";

  it("deactivates ghost rows (archived or node-less) and leaves live rows alone", () => {
    const store = Store.open(makeBackend());
    // A live class: node active, registry active — untouched by the scrub.
    store.apply(env("class.create", { classId: LIVE, contentAst: [{ type: "text", text: "Live" }] }, 1727200001000));
    // An archived class via the pre-mirror era state: node archived by direct
    // write, registry row left active (the divergent projection the scrub fixes).
    store.apply(env("class.create", { classId: ARCHIVED, contentAst: [{ type: "text", text: "Archived" }] }, 1727200001100));
    store.database.prepare("UPDATE node SET is_active = 0 WHERE id = ?").run(ARCHIVED);
    // A purged class: the node row is GONE, the registry row left active
    // (the withdrawn-system-class ghost — `class`/`page`/`cover` in the live
    // workspaces). Unreachable by any op (requireNode), so raw SQL.
    store.database
      .prepare(
        "INSERT INTO class (id, workspace_id, name, active, created_at, updated_at) VALUES (?, 'ws', 'Ghost', 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')",
      )
      .run(PURGED);
    store.database.pragma("user_version = 27");

    migrate(store.database, "fts5");
    expect(store.database.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(registryRow(store, LIVE).active).toBe(1);
    expect(registryRow(store, ARCHIVED).active).toBe(0);
    expect(registryRow(store, PURGED).active).toBe(0);
    // Idempotent: a second migrate no-ops on current version.
    migrate(store.database, "fts5");
    expect(registryRow(store, LIVE).active).toBe(1);
    store.close();
  });

  it("does not mint ghosts: registry rows replayed from the log are purged with their node", () => {
    const store = Store.open(makeBackend());
    // The purge mirror (object.delete permanent) deletes the registry row,
    // so a full replay of a class lifecycle converges WITHOUT the scrub.
    store.apply(env("class.create", { classId: PURGED, contentAst: [{ type: "text", text: "Ghost" }] }, 1727200001000));
    store.apply(env("object.delete", { objectId: PURGED, permanent: true }, 1727200001100));
    expect(store.database.prepare("SELECT 1 FROM class WHERE id = ?").get(PURGED)).toBeUndefined();
    store.close();
  });
});
