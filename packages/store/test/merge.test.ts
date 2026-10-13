/**
 * Node merge planner tests (SCHEMA.md "Node merge"): the plan is a pure
 * read over the derived store, composed ONLY of existing op types — the
 * suite replays plans through Store.apply on BOTH adapters and asserts the
 * derived end state, guard loudness, and wipe → replay determinism.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import initSqlJs, { type SqlJsStatic } from "sql.js";

import { newEnvelope, type Envelope } from "@notees/protocol";

import {
  MergeGuardError,
  Store,
  planMerge,
  rewriteMentionTargets,
  rewriteNodeRefs,
  type StoreBackend,
} from "../src/index.js";
import { betterSqlite3Backend } from "../src/adapters/better-sqlite3.js";
import { sqljsBackend } from "../src/adapters/sqljs.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

const SOURCE = "0192a000-0000-7000-8000-0000000000b1";
const TARGET = "0192a000-0000-7000-8000-0000000000b2";
const CHILD_BLOCK = "0192a000-0000-7000-8000-0000000000b3";
const CHILD_PAGE = "0192a000-0000-7000-8000-0000000000b4";
const REFERRER = "0192a000-0000-7000-8000-0000000000b5";
const OTHER_PAGE = "0192a000-0000-7000-8000-0000000000b6";
const ALIAS_NODE = "0192a000-0000-7000-8000-0000000000b7";
const COLLECTION = "0192a000-0000-7000-8000-0000000000b8";
const CLASS_NODE = "0192a000-0000-7000-8000-0000000000b9";
const TAG_NODE = "0192a000-0000-7000-8000-0000000000ba";
const SCHEMA_TEXT = "0192a000-0000-7000-8000-0000000000d1";
const SCHEMA_NOTES = "0192a000-0000-7000-8000-0000000000d2";
const SCHEMA_REF = "0192a000-0000-7000-8000-0000000000d3";

let clock = 1_000;

function env(opType: string, payload: Record<string, unknown>): Envelope {
  const physical = clock++;
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: "test-device-merge",
    hlc: { physical, logical: 0 },
    opType,
    payload,
    timestamp: new Date(physical).toISOString(),
  });
}

/** The canonical fixture: source with everything mergeable, target plain. */
function fixtureEnvelopes(): Envelope[] {
  clock = 1_000;
  return [
    env("object.create", { objectId: SOURCE, contentAst: [{ type: "text", text: "Source page" }] }),
    env("object.create", { objectId: TARGET, contentAst: [{ type: "text", text: "Target page" }] }),
    env("object.create", {
      objectId: CHILD_BLOCK,
      parentId: SOURCE,
      presentAsMain: false,
      contentAst: [{ type: "text", text: "A block" }],
    }),
    env("object.create", {
      objectId: CHILD_PAGE,
      parentId: SOURCE,
      contentAst: [{ type: "text", text: "A child page" }],
    }),
    env("class.create", { classId: CLASS_NODE, contentAst: [{ type: "text", text: "Book" }] }),
    env("object.create", { objectId: SOURCE, classIds: [CLASS_NODE] }),
    env("object.create", { objectId: SOURCE, tagIds: [TAG_NODE] }),
    env("propertySchema.create", { propertySchemaId: SCHEMA_TEXT, name: "Status", type: "text" }),
    env("propertySchema.create", {
      propertySchemaId: SCHEMA_NOTES,
      name: "Notes",
      type: "text",
      multi: true,
    }),
    env("propertySchema.create", {
      propertySchemaId: SCHEMA_REF,
      name: "Related",
      type: "object",
      multi: true,
    }),
    // Source values: one single-value, two multi-value (one self-referencing).
    env("property.set", { objectId: SOURCE, propertySchemaId: SCHEMA_TEXT, value: "draft", idx: 0 }),
    env("property.set", {
      objectId: SOURCE,
      propertySchemaId: SCHEMA_NOTES,
      value: "first note",
      idx: 0,
      elementId: "0192a000-0000-7000-8000-0000000000e1",
    }),
    env("property.set", {
      objectId: SOURCE,
      propertySchemaId: SCHEMA_NOTES,
      value: "self note",
      idx: 1,
      elementId: "0192a000-0000-7000-8000-0000000000e2",
    }),
    env("property.set", {
      objectId: SOURCE,
      propertySchemaId: SCHEMA_REF,
      value: { nodeId: SOURCE },
      idx: 0,
      elementId: "0192a000-0000-7000-8000-0000000000e3",
    }),
    // Target already has a Status value (target must win the single slot).
    env("property.set", { objectId: TARGET, propertySchemaId: SCHEMA_TEXT, value: "final", idx: 0 }),
    // Referrer mentions the source (top level + inside a quote); other page
    // mentions someone else. The rich tokens ride a follow-up update — a
    // parentless create flattens content to text-only.
    env("object.create", { objectId: REFERRER }),
    env("object.update", {
      objectId: REFERRER,
      contentAst: [
        { type: "text", text: "see " },
        { type: "mention", targetNodeId: SOURCE, text: "Source page" },
        {
          type: "quote",
          children: [{ type: "mention", targetNodeId: SOURCE, text: "Source page" }],
        },
      ],
    }),
    env("object.create", {
      objectId: OTHER_PAGE,
      contentAst: [{ type: "text", text: "other page" }],
    }),
    // An alias node pointing at the source; a collection holding it.
    env("object.create", { objectId: ALIAS_NODE }),
    env("object.update", { objectId: ALIAS_NODE, aliasedNodeId: SOURCE }),
    env("object.create", { objectId: COLLECTION }),
    env("collection.member.add", { collectionId: COLLECTION, objectId: SOURCE }),
    // Another node holds a node-typed property value pointing at the source.
    env("property.set", {
      objectId: OTHER_PAGE,
      propertySchemaId: SCHEMA_REF,
      value: { nodeId: SOURCE },
      idx: 0,
      elementId: "0192a000-0000-7000-8000-0000000000e4",
    }),
  ];
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
      const dir = mkdtempSync(join(tmpdir(), "notees-merge-test-"));
      tmpDirs.push(dir);
      return betterSqlite3Backend(join(dir, "store.db"));
    },
  },
];

function dumpDb(store: Store): Record<string, unknown[]> {
  const tables = (
    store.database
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         AND name NOT IN ('search_index_data', 'search_index_idx', 'search_index_config',
           'search_index_docsize', 'search_index_content',
           'search_index_segments', 'search_index_segdir', 'search_index_stat')
         AND name NOT IN ('sync_state', 'applied_envelope') ORDER BY name`,
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

const text = (n: number) => ({ type: "text", text: `n${n}` });

for (const adapter of adapters) {
  describe(`merge planner (${adapter.name})`, () => {
    it("plans only existing op types and trashes the source last", () => {
      const store = Store.open(adapter.makeBackend());
      for (const e of fixtureEnvelopes()) store.apply(e);

      const plan = planMerge(store.database, SOURCE, TARGET);
      const opTypes = new Set(plan.ops.map((o) => o.opType));
      for (const t of opTypes) {
        expect(
          [
            "object.move",
            "object.create",
            "class.unassign",
            "tag.unassign",
            "property.set",
            "object.update",
            "collection.member.add",
            "collection.member.remove",
            "object.delete",
          ],
        ).toContain(t);
      }
      expect(plan.ops[plan.ops.length - 1]).toEqual({
        opType: "object.delete",
        payload: { objectId: SOURCE, permanent: false },
      });
    });

    it("merges end to end: children, classes, tags, properties, links, aliases, collections", () => {
      const store = Store.open(adapter.makeBackend());
      for (const e of fixtureEnvelopes()) store.apply(e);

      const plan = planMerge(store.database, SOURCE, TARGET);
      for (const op of plan.ops) store.apply(env(op.opType, op.payload));

      // Source trashed, target active.
      expect(store.getNode(SOURCE)?.is_active).toBe(0);
      expect(store.getNode(TARGET)?.is_active).toBe(1);
      expect(
        store.database.prepare("SELECT 1 FROM trash WHERE node_id = ?").get(SOURCE),
      ).toBeDefined();

      // Children moved in order (block first, then the child page).
      const childIds = store.children(TARGET).map((r) => r.id);
      expect(childIds).toEqual([CHILD_BLOCK, CHILD_PAGE]);
      expect(store.children(SOURCE)).toEqual([]);

      // Class + tag remapped: target holds them, source holds none.
      expect(JSON.parse(store.getNode(TARGET)!.class_ids)).toEqual([CLASS_NODE]);
      expect(JSON.parse(store.getNode(TARGET)!.tag_ids)).toEqual([TAG_NODE]);
      expect(JSON.parse(store.getNode(SOURCE)!.class_ids)).toEqual([]);
      expect(JSON.parse(store.getNode(SOURCE)!.tag_ids)).toEqual([]);

      // Properties: single-value slot kept the TARGET's value; multi-value
      // appended both source elements under NEW element ids; the
      // self-referencing value on the source rewrote to the target.
      const targetProps = store.getEffectiveProperties(TARGET);
      const status = targetProps.filter((p) => p.propertySchemaId === SCHEMA_TEXT);
      expect(status).toHaveLength(1);
      expect(status[0]?.value).toBe("final");
      const notes = targetProps
        .filter((p) => p.propertySchemaId === SCHEMA_NOTES)
        .map((p) => p.value)
        .sort();
      expect(notes).toEqual(["first note", "self note"]);
      const related = targetProps.filter((p) => p.propertySchemaId === SCHEMA_REF);
      expect(related).toHaveLength(1);
      expect(related[0]?.value).toEqual({ nodeId: TARGET });
      // The copied elements carry fresh ids, not the source's.
      const sourceEl = "0192a000-0000-7000-8000-0000000000e1";
      expect(targetProps.some((p) => p.elementId === sourceEl)).toBe(false);

      // Incoming mention rewritten (both the top-level and the quoted one);
      // the other page's self-mention untouched.
      const referrer = store.getNode(REFERRER)!;
      const referrerAst = JSON.parse(referrer.content) as Array<Record<string, unknown>>;
      expect(referrerAst[1]).toMatchObject({ type: "mention", targetNodeId: TARGET });
      const quote = referrerAst[2] as { children: Array<Record<string, unknown>> };
      expect(quote.children[0]).toMatchObject({ type: "mention", targetNodeId: TARGET });
      const otherAst = JSON.parse(store.getNode(OTHER_PAGE)!.content) as Array<
        Record<string, unknown>
      >;
      expect(otherAst).toEqual([{ type: "text", text: "other page" }]);

      // Alias repointed to the target.
      expect(store.getNode(ALIAS_NODE)?.aliased_node_id).toBe(TARGET);

      // Node-typed property value on the other page rewrote to the target.
      const otherProps = store.getEffectiveProperties(OTHER_PAGE);
      const otherRef = otherProps.find((p) => p.propertySchemaId === SCHEMA_REF);
      expect(otherRef?.value).toEqual({ nodeId: TARGET });

      // Collection membership remapped.
      const membership = store.database
        .prepare(
          "SELECT present FROM collection_member WHERE collection_id = ? AND object_id = ?",
        )
        .get(COLLECTION, TARGET) as { present: number } | undefined;
      expect(membership?.present).toBe(1);
      const sourceMembership = store.database
        .prepare(
          "SELECT present FROM collection_member WHERE collection_id = ? AND object_id = ?",
        )
        .get(COLLECTION, SOURCE) as { present: number } | undefined;
      expect(sourceMembership?.present).toBe(0);

      // Summary counts line up with the fixture shape.
      expect(plan.summary).toEqual({
        childrenMoved: 2,
        classesRemapped: 1,
        tagsRemapped: 1,
        propertiesCopied: 3,
        propertiesSkipped: 1,
        contentLinksRewritten: 1,
        propertyValuesRewritten: 1,
        aliasesRepointed: 1,
        collectionsRemapped: 1,
        fieldsCopied: 0,
      });
    });

    it("wipe → replay is deterministic", () => {
      const setup = fixtureEnvelopes();
      const storeA = Store.open(adapter.makeBackend());
      for (const e of setup) storeA.apply(e);
      const plan = planMerge(storeA.database, SOURCE, TARGET);
      const planEnvelopes = plan.ops.map((op) => env(op.opType, op.payload));
      for (const e of planEnvelopes) storeA.apply(e);

      const storeB = Store.open(adapter.makeBackend());
      for (const e of setup) storeB.apply(e);
      for (const e of planEnvelopes) storeB.apply(e);

      expect(dumpDb(storeA)).toEqual(dumpDb(storeB));
    });

    it("re-planning after a merge produces a minimal no-op plan", () => {
      const store = Store.open(adapter.makeBackend());
      for (const e of fixtureEnvelopes()) store.apply(e);
      const plan = planMerge(store.database, SOURCE, TARGET);
      for (const op of plan.ops) store.apply(env(op.opType, op.payload));

      // The source is trashed now — merging it again fails loud.
      expect(() => planMerge(store.database, SOURCE, TARGET)).toThrow(MergeGuardError);
    });

    it("copies cover/banner/description only into empty target fields", () => {
      const setup = [
        ...fixtureEnvelopes(),
        env("object.update", { objectId: SOURCE, coverAssetId: CHILD_PAGE, description: "sub" }),
      ];
      const store = Store.open(adapter.makeBackend());
      for (const e of setup) store.apply(e);

      const plan = planMerge(store.database, SOURCE, TARGET);
      for (const op of plan.ops) store.apply(env(op.opType, op.payload));

      const target = store.getNode(TARGET)!;
      expect(target.cover_asset_id).toBe(CHILD_PAGE);
      expect(target.description).toBe("sub");
      expect(plan.summary.fieldsCopied).toBe(2);
    });

    it.each([
      ["same node", SOURCE, SOURCE],
      ["missing source", "0192a000-0000-7000-8000-0000000000bf", TARGET],
      ["class source", CLASS_NODE, TARGET],
      ["class target", SOURCE, CLASS_NODE],
    ])("guards fail loud: %s", (_label, s, t) => {
      const store = Store.open(adapter.makeBackend());
      for (const e of fixtureEnvelopes()) store.apply(e);
      expect(() => planMerge(store.database, s, t)).toThrow(MergeGuardError);
    });

    it("guards fail loud: target inside the source subtree", () => {
      const store = Store.open(adapter.makeBackend());
      for (const e of fixtureEnvelopes()) store.apply(e);
      expect(() => planMerge(store.database, SOURCE, CHILD_PAGE)).toThrow(MergeGuardError);
    });

    it("guards fail loud: trashed source", () => {
      const store = Store.open(adapter.makeBackend());
      for (const e of fixtureEnvelopes()) store.apply(e);
      store.apply(env("object.delete", { objectId: SOURCE, permanent: false }));
      expect(() => planMerge(store.database, SOURCE, TARGET)).toThrow(MergeGuardError);
    });

    it("guards fail loud: non-empty collection source", () => {
      const store = Store.open(adapter.makeBackend());
      for (const e of fixtureEnvelopes()) store.apply(e);
      expect(() => planMerge(store.database, COLLECTION, TARGET)).toThrow(MergeGuardError);
    });
  });
}

describe("rewrite helpers", () => {
  it("rewriteNodeRefs rewrites nested nodeId references only", () => {
    const value = {
      nodeId: SOURCE,
      time: { nodeId: "0192a000-0000-7000-8000-0000000000keep", time: { nodeId: SOURCE } },
      label: "plain",
    };
    expect(rewriteNodeRefs(value, SOURCE, TARGET)).toEqual({
      nodeId: TARGET,
      time: { nodeId: "0192a000-0000-7000-8000-0000000000keep", time: { nodeId: TARGET } },
      label: "plain",
    });
  });

  it("rewriteMentionTargets rewrites mentions at any depth, leaves siblings", () => {
    const ast = [
      { type: "mention", targetNodeId: SOURCE, text: "x" },
      { type: "quote", children: [{ type: "mention", targetNodeId: SOURCE, text: "y" }] },
      { type: "mention", targetNodeId: OTHER_PAGE, text: "z" },
      text(1),
    ];
    const { ast: rewritten, changed } = rewriteMentionTargets(ast, SOURCE, TARGET);
    expect(changed).toBe(true);
    expect(rewritten[0]).toMatchObject({ targetNodeId: TARGET });
    expect((rewritten[1] as { children: unknown[] }).children[0]).toMatchObject({
      targetNodeId: TARGET,
    });
    expect(rewritten[2]).toMatchObject({ targetNodeId: OTHER_PAGE });

    const noChange = rewriteMentionTargets([text(1)], SOURCE, TARGET);
    expect(noChange.changed).toBe(false);
  });
});
