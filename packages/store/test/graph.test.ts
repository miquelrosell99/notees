/**
 * graph.ts topology projection tests (§34.80): the node set (classes +
 * present-as-main only — blocks never render), the containment rollup for
 * every edge family, the semantic co-occurrence projection (clique, weight,
 * hub guard, evidence), and the local-scope BFS.
 */

import { describe, expect, it } from "vitest";

import { newEnvelope, type Envelope } from "@notees/protocol";

import { graphTopology } from "../src/graph.js";
import { Store } from "../src/index.js";
import { betterSqlite3Backend } from "../src/adapters/better-sqlite3.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

const PAGE_A = "0192a000-0000-7000-8000-0000000000a1";
const PAGE_B = "0192a000-0000-7000-8000-0000000000a2";
const PAGE_C = "0192a000-0000-7000-8000-0000000000a3";
const PAGE_D = "0192a000-0000-7000-8000-0000000000a4";
const BLOCK_B1 = "0192a000-0000-7000-8000-0000000000b1";
const BLOCK_C1 = "0192a000-0000-7000-8000-0000000000b2";
const CLASS_X = "0192a000-0000-7000-8000-0000000000c1";

let clock = 1_000;

function env(opType: string, payload: Record<string, unknown>): Envelope {
  clock += 10;
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: "test-device-graph",
    hlc: { physical: clock, logical: 0 },
    opType,
    payload,
    timestamp: new Date(clock).toISOString(),
  });
}

function createPage(id: string): Envelope {
  return env("object.create", { objectId: id });
}

function createBlock(id: string, parentId: string): Envelope {
  return env("object.create", { objectId: id, parentId, presentAsMain: false });
}

function mention(target: string, text: string): Record<string, unknown> {
  return { type: "mention", targetNodeId: target, text };
}

/** Apply envelopes to a fresh in-memory store. */
function setup(...envelopes: Envelope[]): Store {
  const store = Store.open(betterSqlite3Backend());
  for (const envelope of envelopes) store.apply(envelope);
  return store;
}

function edge(topology: ReturnType<typeof graphTopology>, kind: string, source: string, target: string) {
  return topology.edges.find(
    (e) => e.kind === kind && e.source === source && e.target === target,
  );
}

describe("graphTopology", () => {
  it("node set is classes + main nodes only; blocks never render", () => {
    const store = setup(createPage(PAGE_A), createBlock(BLOCK_B1, PAGE_A));
    const topology = graphTopology(store, WS);
    const ids = topology.nodes.map((n) => n.id);
    expect(ids).toContain(PAGE_A);
    expect(ids).not.toContain(BLOCK_B1);
  });

  it("a block-authored mention rolls up to page → page", () => {
    const store = setup(
      createPage(PAGE_A),
      createPage(PAGE_B),
      createBlock(BLOCK_B1, PAGE_B),
      env("object.update", {
        objectId: BLOCK_B1,
        contentAst: [mention(PAGE_A, "A")],
      }),
    );
    const topology = graphTopology(store, WS);
    expect(edge(topology, "mention", PAGE_B, PAGE_A)).toBeDefined();
    expect(topology.edges.every((e) => e.source !== BLOCK_B1)).toBe(true);
  });

  it("a block target rolls up to its containing page", () => {
    const store = setup(
      createPage(PAGE_A),
      createPage(PAGE_B),
      createBlock(BLOCK_B1, PAGE_B),
      createBlock(BLOCK_C1, PAGE_A),
      env("object.update", {
        objectId: BLOCK_C1,
        contentAst: [mention(BLOCK_B1, "b1")],
      }),
    );
    const topology = graphTopology(store, WS);
    const rolled = edge(topology, "mention", PAGE_A, PAGE_B);
    expect(rolled).toBeDefined();
    expect(rolled!.weight).toBe(1);
  });

  it("parent edges exist only between main nodes; class membership edges appear", () => {
    const store = setup(
      env("class.create", { classId: CLASS_X }),
      env("object.create", { objectId: PAGE_A, classIds: [CLASS_X] }),
      createBlock(BLOCK_B1, PAGE_A),
    );
    const topology = graphTopology(store, WS);
    expect(edge(topology, "parent", PAGE_A, BLOCK_B1)).toBeUndefined();
    expect(edge(topology, "class", PAGE_A, CLASS_X)).toBeDefined();
    // The class itself is in the node set.
    expect(topology.nodes.some((n) => n.id === CLASS_X && n.isClass)).toBe(true);
  });

  it("multiplicity accumulates into weight", () => {
    const store = setup(
      createPage(PAGE_A),
      createPage(PAGE_B),
      createBlock(BLOCK_B1, PAGE_B),
      createBlock(BLOCK_C1, PAGE_B),
      env("object.update", { objectId: BLOCK_B1, contentAst: [mention(PAGE_A, "A")] }),
      env("object.update", { objectId: BLOCK_C1, contentAst: [mention(PAGE_A, "A")] }),
    );
    const topology = graphTopology(store, WS);
    expect(edge(topology, "mention", PAGE_B, PAGE_A)!.weight).toBe(2);
  });

  it("semantic co-occurrence: a block mentioning two pages links them with evidence", () => {
    const store = setup(
      createPage(PAGE_A),
      createPage(PAGE_B),
      createPage(PAGE_C),
      createBlock(BLOCK_B1, PAGE_B),
      env("object.update", {
        objectId: BLOCK_B1,
        contentAst: [mention(PAGE_A, "A"), mention(PAGE_C, "C")],
      }),
    );
    const topology = graphTopology(store, WS);
    const semantic = edge(topology, "semantic", PAGE_A, PAGE_C);
    expect(semantic).toBeDefined();
    expect(semantic!.weight).toBe(1);
    expect(semantic!.evidence).toEqual([BLOCK_B1]);
    // The rolled context (PAGE_B) self-pair is dropped.
    expect(edge(topology, "semantic", PAGE_B, PAGE_B)).toBeUndefined();
  });

  it("hub guard: a context with >10 distinct targets emits no clique", () => {
    const pages = Array.from({ length: 12 }, (_, i) =>
      `0192a000-0000-7000-8000-000000000${String(i).padStart(3, "0")}`,
    );
    const store = setup(
      createPage(PAGE_A),
      createPage(PAGE_B),
      createBlock(BLOCK_B1, PAGE_B),
      ...pages.map(createPage),
      env("object.update", {
        objectId: BLOCK_B1,
        contentAst: pages.map((p) => mention(p, p.slice(-4))),
      }),
    );
    const topology = graphTopology(store, WS);
    expect(topology.edges.every((e) => e.kind !== "semantic")).toBe(true);
  });

  it("inactive nodes are excluded entirely", () => {
    const store = setup(
      createPage(PAGE_A),
      createPage(PAGE_B),
      env("object.delete", { objectId: PAGE_B }),
    );
    const topology = graphTopology(store, WS);
    expect(topology.nodes.some((n) => n.id === PAGE_B)).toBe(false);
  });

  it("local scope BFS keeps the depth-limited neighborhood (semantic edges participate)", () => {
    const store = setup(
      createPage(PAGE_A),
      createPage(PAGE_B),
      createPage(PAGE_C),
      createPage(PAGE_D),
      createBlock(BLOCK_B1, PAGE_B),
      createBlock(BLOCK_C1, PAGE_C),
      env("object.update", { objectId: BLOCK_B1, contentAst: [mention(PAGE_A, "A"), mention(PAGE_C, "C")] }),
      env("object.update", { objectId: BLOCK_C1, contentAst: [mention(PAGE_D, "D")] }),
    );
    // Depth 1: PAGE_B (structural) + PAGE_C (structural AND the semantic
    // co-occurrence edge from the two mentions in BLOCK_B1).
    const depth1 = graphTopology(store, WS, { anchor: PAGE_A, depth: 1 });
    expect(depth1.nodes.map((n) => n.id).sort()).toEqual([PAGE_A, PAGE_B, PAGE_C]);
    const depth2 = graphTopology(store, WS, { anchor: PAGE_A, depth: 2 });
    expect(depth2.nodes.map((n) => n.id).sort()).toEqual([PAGE_A, PAGE_B, PAGE_C, PAGE_D]);
  });
});
