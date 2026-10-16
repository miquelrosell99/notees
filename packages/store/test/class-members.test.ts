/**
 * Class members — the family read (owner fix): a class's classed-nodes
 * section lists members of the class AND its transitive extends-children
 * (the class_hierarchy closure), deduped; the count matches.
 */

import { describe, expect, it } from "vitest";

import { newEnvelope, type Envelope } from "@notees/protocol";

import { Store } from "../src/index.js";
import { betterSqlite3Backend } from "../src/adapters/better-sqlite3.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

const AGENT = "0192a000-0000-7000-8000-0000000000c1";
const PERSON = "0192a000-0000-7000-8000-0000000000c2";
const ORG = "0192a000-0000-7000-8000-0000000000c3";
const ALIEN = "0192a000-0000-7000-8000-0000000000c4";

let clock = 1_000;

function env(opType: string, payload: Record<string, unknown>): Envelope {
  clock += 10;
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: "test-device-class-members",
    hlc: { physical: clock, logical: 0 },
    opType,
    payload,
    timestamp: new Date(clock).toISOString(),
  });
}

describe("classMembers — the family read", () => {
  it("includes members of transitive extends-children, deduped, with a matching count", () => {
    const store = Store.open(betterSqlite3Backend());
    const apply = (...envelopes: Envelope[]) => envelopes.forEach((e) => store.apply(e));
    apply(
      env("class.create", { classId: AGENT }),
      env("class.create", { classId: PERSON }),
      env("class.create", { classId: ORG }),
      env("class.create", { classId: ALIEN }),
      env("class.setExtends", { classId: PERSON, parentClassIds: [AGENT] }),
      env("class.setExtends", { classId: ORG, parentClassIds: [AGENT] }),
      env("class.setExtends", { classId: ALIEN, parentClassIds: [PERSON] }),
      // A person who is ALSO a direct agent member must list once.
      env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000d1", classIds: [PERSON, AGENT] }),
      env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000d2", classIds: [ORG] }),
      env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000d3", classIds: [ALIEN] }),
      env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000d4", classIds: [AGENT] }),
      // A non-member must never appear.
      env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000d5" }),
    );

    const agentIds = store.classMembers(AGENT).map((row) => row.id).sort();
    expect(agentIds).toEqual([
      "0192a000-0000-7000-8000-0000000000d1",
      "0192a000-0000-7000-8000-0000000000d2",
      "0192a000-0000-7000-8000-0000000000d3",
      "0192a000-0000-7000-8000-0000000000d4",
    ]);
    expect(store.classMembersCount(AGENT)).toBe(4);

    // Direct-only reads still work for the leaf classes.
    expect(store.classMembers(ALIEN).map((row) => row.id)).toEqual([
      "0192a000-0000-7000-8000-0000000000d3",
    ]);
    expect(store.classMembersCount(ALIEN)).toBe(1);
  });
});

describe("content-asserted membership — the no-divergence law (owner ruling 2026-10-15)", () => {
  it("object.create/update carrying class_link tokens OR-set-adds the classes — any writer converges", () => {
    const store = Store.open(betterSqlite3Backend());
    const apply = (...envelopes: Envelope[]) => envelopes.forEach((e) => store.apply(e));
    apply(env("class.create", { classId: PERSON }));
    // A raw writer (no explicit classIds) links the class inline…
    apply(
      env("object.create", {
        objectId: AGENT,
        parentId: null,
        isEmbedded: true,
        classIds: [],
        contentAst: [{ type: "class_link", classId: PERSON }],
      }),
    );
    const row = store.database.prepare("SELECT class_ids FROM node WHERE id = ?").get(AGENT) as {
      class_ids: string;
    };
    expect(JSON.parse(row.class_ids)).toEqual([PERSON]);
    // …and a later update asserting ANOTHER class via a quote child adds it too.
    apply(env("class.create", { classId: ORG }));
    apply(
      env("object.update", {
        objectId: AGENT,
        contentAst: [
          { type: "class_link", classId: PERSON },
          { type: "quote", children: [{ type: "class_link", classId: ORG }] },
        ],
      }),
    );
    const row2 = store.database.prepare("SELECT class_ids FROM node WHERE id = ?").get(AGENT) as {
      class_ids: string;
    };
    expect(JSON.parse(row2.class_ids)).toEqual(expect.arrayContaining([PERSON, ORG]));
    // Document-chrome content flattens to text-only: a rich-title update is
    // the assertion path for main nodes.
    apply(
      env("object.create", { objectId: ALIEN, parentId: null, isEmbedded: false, classIds: [], contentAst: [{ type: "text", text: "Main" }] }),
    );
    apply(
      env("object.update", {
        objectId: ALIEN,
        contentAst: [{ type: "class_link", classId: PERSON }],
      }),
    );
    const row3 = store.database.prepare("SELECT class_ids FROM node WHERE id = ?").get(ALIEN) as {
      class_ids: string;
    };
    expect(JSON.parse(row3.class_ids)).toEqual([PERSON]);
    store.close();
  });

  it("class.unassign refuses while the content references the class — loud, never applied", () => {
    const store = Store.open(betterSqlite3Backend());
    const apply = (...envelopes: Envelope[]) => envelopes.forEach((e) => store.apply(e));
    apply(
      env("class.create", { classId: PERSON }),
      env("object.create", {
        objectId: AGENT,
        parentId: null,
        isEmbedded: true,
        classIds: [],
        contentAst: [{ type: "class_link", classId: PERSON }],
      }),
    );
    expect(() => apply(env("class.unassign", { objectId: AGENT, classId: PERSON }))).toThrow(
      /content references class/,
    );
    // The refusal left membership intact.
    const row = store.database.prepare("SELECT class_ids FROM node WHERE id = ?").get(AGENT) as {
      class_ids: string;
    };
    expect(JSON.parse(row.class_ids)).toEqual([PERSON]);
    // Strip-then-unassign (the removal gesture's envelope order) converges.
    apply(env("object.update", { objectId: AGENT, contentAst: [{ type: "text", text: "plain" }] }));
    apply(env("class.unassign", { objectId: AGENT, classId: PERSON }));
    const row2 = store.database.prepare("SELECT class_ids FROM node WHERE id = ?").get(AGENT) as {
      class_ids: string;
    };
    expect(JSON.parse(row2.class_ids)).toEqual([]);
    store.close();
  });
});
