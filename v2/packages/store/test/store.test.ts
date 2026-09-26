/**
 * Derived-state store tests: schema invariants (bullet-proof CHECKs),
 * canonical fixture replay from @notees/protocol, LWW/OR-Set convergence,
 * op-log idempotency, wipe -> replay determinism, and FTS5 search.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { newEnvelope, type ContentAst, type Envelope } from "@notees/protocol";

import {
  CheckConstraintError,
  CycleError,
  MoveGuardError,
  Store,
  UnsupportedCarrierError,
} from "../src/index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "protocol", "fixtures");

/** Fixture envelopes, in a fixed order (alphabetical by file name). */
const FIXTURE_FILES = readdirSync(fixturesDir).filter((f) => f.endsWith(".json")).sort();

function loadFixture(name: string): Record<string, unknown>[] {
  const raw = JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as {
    envelopes?: Record<string, unknown>[];
  };
  return Array.isArray(raw.envelopes) ? raw.envelopes : [raw as Record<string, unknown>];
}

function allFixtureEnvelopes(): Record<string, unknown>[] {
  return FIXTURE_FILES.flatMap(loadFixture);
}

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const NODE_PAGE = "0192a000-0000-7000-8000-000000000010";
const NODE_BOOK = "0192a000-0000-7000-8000-000000000011";
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

function baseStore(): Store {
  const store = new Store();
  store.applyMany([createPage(NODE_PAGE, 1727200000000), createPage(NODE_BOOK, 1727200001000)]);
  return store;
}

/**
 * Full-database dump, deterministic ordering, for convergence checks.
 * Excludes sync_state (restore_epoch is environmental) and, by default,
 * applied_envelope (the local application log — its seq is the local apply
 * order, so cross-order comparisons legitimately differ; same-order replay
 * comparisons can opt back in with `withAppliedLog`).
 */
function dumpDb(store: Store, options: { withAppliedLog?: boolean } = {}): Record<string, unknown[]> {
  const tables = (
    store.database
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         AND name NOT IN (
           'search_index_data', 'search_index_idx', 'search_index_config',
           'search_index_docsize', 'search_index_content'
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

describe("schema invariants (bullet-proof CHECKs)", () => {
  it("rejects a parentless block row", () => {
    const store = new Store();
    expect(() =>
      store.database
        .prepare("INSERT INTO node (id, workspace_id, node_type, parent_id) VALUES ('a', 'ws', 'block', NULL)")
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it("rejects a class row with a parent", () => {
    const store = new Store();
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
    const store = new Store();
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
    store.apply(env("class.create", { classId: "c0000000-0000-7000-8000-0000000000c1", name: "Tag" }, 1727200001500));
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
    const store = new Store();
    store.applyMany(allFixtureEnvelopes());
    const page = store.getNode(NODE_PAGE);
    const book = store.getNode(NODE_BOOK);
    expect(page?.node_type).toBe("page");
    expect(book?.node_type).toBe("page");
    expect(book?.name).toBe("The Structure of Scientific Revolutions");
    // classIds seed the OR-Set membership, projected into node.class_ids.
    expect(JSON.parse(book?.class_ids ?? "[]")).toEqual([BOOK_CLASS]);
  });

  it("converges the property LWW fixture to the higher-HLC phone value", () => {
    const store = new Store();
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
    const store = baseStore();
    store.applyMany(loadFixture("typed-link-mark.json"));
    const edge = store.database
      .prepare("SELECT * FROM edge WHERE source_id = ? AND type = 'typed_link'")
      .get(NODE_PAGE) as Record<string, unknown>;
    expect(edge).toBeDefined();
    expect(edge.verb).toBe("cites");
    const metadata = JSON.parse(edge.metadata as string);
    expect(metadata.locator).toBe("p. 42");
    expect(metadata.candidateSpans).toEqual(["tok_3", "tok_7"]);
    // The mention token in the same content derives a mention edge.
    const mention = store.database
      .prepare("SELECT * FROM edge WHERE source_id = ? AND type = 'mention'")
      .get(NODE_PAGE) as { target_id: string } | undefined;
    expect(mention?.target_id).toBe(NODE_BOOK);
  });

  it("drops the typed_link edge when the marked word is deleted", () => {
    const store = baseStore();
    store.applyMany(loadFixture("typed-link-mark.json"));
    store.applyMany(loadFixture("typed-link-mark-deleted.json"));
    const typedLinks = store.database
      .prepare("SELECT COUNT(*) AS n FROM edge WHERE source_id = ? AND type = 'typed_link'")
      .get(NODE_PAGE) as { n: number };
    expect(typedLinks.n).toBe(0);
    const mentions = store.database
      .prepare("SELECT COUNT(*) AS n FROM edge WHERE source_id = ? AND type = 'mention'")
      .get(NODE_PAGE) as { n: number };
    expect(mentions.n).toBe(0);
    const content = JSON.parse(store.getNode(NODE_PAGE)?.content ?? "[]") as ContentAst;
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
    const base = [createPage(NODE_PAGE, 1727200000000), createPage(NODE_BOOK, 1727200001000)];
    const storeA = new Store();
    storeA.applyMany([...base, mark, deleted]);
    const storeB = new Store();
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
      env("object.update", { objectId: NODE_BOOK, name: "stale name" }, 1727200000900, 0),
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
    store.apply(env("class.create", { classId: a, name: "Source" }, 1727200001000));
    store.apply(env("class.create", { classId: b, name: "Work" }, 1727200001100));
    store.apply(env("class.create", { classId: c, name: "Annotation" }, 1727200001200));
    store.apply(env("class.setExtends", { classId: b, parentClassId: a }, 1727200001300));
    store.apply(env("class.setExtends", { classId: c, parentClassId: b }, 1727200001400));
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
      store.apply(env("class.setExtends", { classId: a, parentClassId: c }, 1727200001500)),
    ).toThrow(CycleError);
    expect(() =>
      store.apply(env("class.setExtends", { classId: a, parentClassId: a }, 1727200001500)),
    ).toThrow(CycleError);
  });

  it("re-applying the whole fixture set is idempotent (applied_envelope)", () => {
    const store = new Store();
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

describe("determinism", () => {
  it("reset() empties the store", () => {
    const store = new Store();
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
    const store1 = new Store();
    store1.applyMany(envelopes);

    const bytes = store1.snapshot();
    const store2 = new Store();
    store2.applyMany(JSON.parse(JSON.stringify(envelopes)));
    expect(dumpDb(store2, { withAppliedLog: true })).toEqual(dumpDb(store1, { withAppliedLog: true }));

    // Snapshot/restore round-trips the same bytes.
    const store3 = new Store();
    store3.restore(bytes);
    expect(dumpDb(store3, { withAppliedLog: true })).toEqual(dumpDb(store1, { withAppliedLog: true }));
    store3.close();
    store2.close();
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

  it("promotes a block to a page and demotes it back in place", () => {
    const store = new Store();
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

describe("search (FTS5)", () => {
  it("finds the block containing 'Kuhn'", () => {
    const store = baseStore();
    store.applyMany(loadFixture("typed-link-mark.json"));
    expect(store.search("Kuhn")).toEqual([{ nodeId: NODE_PAGE }]);
  });

  it("prefix-AND matches across terms", () => {
    const store = baseStore();
    store.applyMany(loadFixture("typed-link-mark.json"));
    expect(store.search("Kuhn Scient")).toEqual([{ nodeId: NODE_PAGE }]);
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
    const store = baseStore();
    store.applyMany(loadFixture("typed-link-mark.json"));
    store.apply(env("object.delete", { objectId: NODE_PAGE }, 1727200010000));
    expect(store.search("Kuhn")).toEqual([]);
  });
});
