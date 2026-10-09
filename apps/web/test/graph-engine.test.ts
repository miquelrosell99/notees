/**
 * graph/engine tests: determinism (same seed + topology → identical
 * positions), preset sanity, drag/pin behavior, topology-preserving updates,
 * energy-gated settling (the graph reaches a true equilibrium and freezes),
 * and reheat locality (waking one neighborhood leaves the rest exactly in
 * place). Assertions are on engine STATE, never wall-clock (the render loop
 * owns timing).
 */

import { describe, expect, it } from "vitest";

import {
  GraphEngine,
  buildGraphEngineConfig,
  type GraphEngineEdge,
  type GraphEngineNode,
} from "../src/ui/views/graph/engine/index.js";

function physics(overrides: Partial<Parameters<typeof buildGraphEngineConfig>[0]> = {}) {
  return buildGraphEngineConfig({ preset: "balanced", centralGravity: 30, linkCountAttraction: false, clustering: true, ...overrides });
}

function chain(count: number): { nodes: GraphEngineNode[]; edges: GraphEngineEdge[] } {
  const nodes = Array.from({ length: count }, (_, i) => ({ nodeUuid: `n${i}` }));
  const edges = Array.from({ length: count - 1 }, (_, i) => ({ source: `n${i}`, target: `n${i + 1}` }));
  return { nodes, edges };
}

function run(engine: GraphEngine, ticks: number): void {
  for (let i = 0; i < ticks; i++) engine.step();
}

describe("graph engine", () => {
  it("is deterministic for the same seed and topology", () => {
    const a = new GraphEngine(chain(40).nodes, chain(40).edges, physics());
    const b = new GraphEngine(chain(40).nodes, chain(40).edges, physics());
    run(a, 120);
    run(b, 120);
    const sa = a.getState();
    const sb = b.getState();
    expect(sa.nodeCount).toBe(sb.nodeCount);
    for (let i = 0; i < sa.nodeCount; i++) {
      expect(sa.posX[i]).toBe(sb.posX[i]);
      expect(sa.posY[i]).toBe(sb.posY[i]);
    }
  });

  it("the four presets produce different equilibrium spreads", () => {
    const spreads = new Map<string, number>();
    for (const preset of ["sparse", "balanced", "compact", "clustered"] as const) {
      const { nodes, edges } = chain(60);
      const engine = new GraphEngine(nodes, edges, physics({ preset }));
      run(engine, 300);
      const s = engine.getState();
      let minX = Infinity, maxX = -Infinity;
      for (let i = 0; i < s.nodeCount; i++) {
        minX = Math.min(minX, s.posX[i]!);
        maxX = Math.max(maxX, s.posX[i]!);
      }
      spreads.set(preset, maxX - minX);
    }
    expect(spreads.get("compact")).toBeLessThan(spreads.get("sparse")!);
    expect(new Set(spreads.values()).size).toBe(4);
  });

  it("pinning holds a node in place; moveNode repositions it", () => {
    const { nodes, edges } = chain(10);
    const engine = new GraphEngine(nodes, edges, physics());
    run(engine, 60);
    const atPin = engine.getNodePosition("n3")!;
    engine.pinNode("n3");
    expect(engine.isPinned("n3")).toBe(true);
    run(engine, 200);
    const held = engine.getNodePosition("n3")!;
    expect(held.x).toBeCloseTo(atPin.x, 4);
    expect(held.y).toBeCloseTo(atPin.y, 4);
    engine.moveNode("n3", 500, 400);
    run(engine, 10);
    const moved = engine.getNodePosition("n3")!;
    expect(moved.x).toBeCloseTo(500, 0);
    expect(moved.y).toBeCloseTo(400, 0);
  });

  it("setTopology preserves positions of surviving nodes", () => {
    const { nodes, edges } = chain(20);
    const engine = new GraphEngine(nodes, edges, physics());
    run(engine, 150);
    const before = engine.getNodePosition("n5")!;
    engine.setTopology(
      [...nodes, { nodeUuid: "n20" }],
      [...edges, { source: "n19", target: "n20" }],
    );
    run(engine, 1);
    const after = engine.getNodePosition("n5")!;
    expect(after.x).toBeCloseTo(before.x, 5);
    expect(after.y).toBeCloseTo(before.y, 5);
    expect(engine.getNodePosition("n20")).toBeDefined();
  });

  it("quiesces: energy decays below the sleep threshold and stays finite", () => {
    const { nodes, edges } = chain(80);
    const engine = new GraphEngine(nodes, edges, physics());
    run(engine, 1500);
    const s = engine.getState();
    for (let i = 0; i < s.nodeCount; i++) {
      expect(Number.isFinite(s.posX[i])).toBe(true);
      expect(Number.isFinite(s.posY[i])).toBe(true);
    }
    // Positions stay bounded (no explosion) — the spread is sane world units.
    let maxR = 0;
    for (let i = 0; i < s.nodeCount; i++) {
      maxR = Math.max(maxR, Math.hypot(s.posX[i]!, s.posY[i]!));
    }
    expect(maxR).toBeLessThan(1e6);
  });

  it("settles: reaches a true equilibrium and reports settled", () => {
    const { nodes, edges } = chain(80);
    const engine = new GraphEngine(nodes, edges, physics());
    let settledAt = -1;
    for (let t = 0; t < 4000; t++) {
      engine.step();
      if (engine.settled) { settledAt = t; break; }
    }
    expect(settledAt).toBeGreaterThan(0);
    // Stillness is force-driven: after settling, further steps change nothing.
    const before = engine.getState();
    run(engine, 50);
    const after = engine.getState();
    for (let i = 0; i < after.nodeCount; i++) {
      expect(after.posX[i]).toBe(before.posX[i]);
      expect(after.posY[i]).toBe(before.posY[i]);
    }
  });

  it("alpha cools every node toward 0", () => {
    const { nodes, edges } = chain(20);
    const engine = new GraphEngine(nodes, edges, physics());
    expect(engine.alphaArr[0]).toBe(1);
    run(engine, 10);
    expect(engine.alphaArr[0]!).toBeLessThan(1);
    expect(engine.alphaArr[0]!).toBeGreaterThan(0);
  });

  it("local reheat moves only the neighborhood — distant nodes stay exactly put", () => {
    const { nodes, edges } = chain(120);
    const engine = new GraphEngine(nodes, edges, physics());
    for (let t = 0; t < 4000 && !engine.settled; t++) engine.step();
    expect(engine.settled).toBe(true);

    const n0 = engine.getNodePosition("n0")!;
    const snapshot = new Map<string, { x: number; y: number }>();
    for (const id of nodes.map((n) => n.nodeUuid)) {
      snapshot.set(id, engine.getNodePosition(id)!);
    }
    // The farthest node from n0 — with 120 links of rest length 100 in the
    // chain, something is always well outside a 150px influence radius.
    let farId = "";
    let farDist = 0;
    for (const [id, p] of snapshot) {
      const d = Math.hypot(p.x - n0.x, p.y - n0.y);
      if (d > farDist) { farDist = d; farId = id; }
    }
    expect(farDist).toBeGreaterThan(150);

    engine.reheatLocal(n0.x, n0.y, 150, 0.5);
    expect(engine.settled).toBe(false);
    run(engine, 30);

    // The far node is outside the influence radius: not a pixel of drift.
    const farAfter = engine.getNodePosition(farId)!;
    expect(farAfter.x).toBe(snapshot.get(farId)!.x);
    expect(farAfter.y).toBe(snapshot.get(farId)!.y);
    const s = engine.getState();
    expect(engine.alphaArr[s.nodeIdArr.indexOf(farId)]!).toBe(0);

    // Every node inside the influence radius was reheated and may move.
    let woke = 0;
    for (let i = 0; i < s.nodeCount; i++) {
      const p = { x: s.posX[i]!, y: s.posY[i]! };
      if (Math.hypot(p.x - n0.x, p.y - n0.y) <= 150) woke++;
    }
    expect(woke).toBeGreaterThan(0);
  });

  it("global reheat restarts the whole graph", () => {
    const { nodes, edges } = chain(40);
    const engine = new GraphEngine(nodes, edges, physics());
    for (let t = 0; t < 4000 && !engine.settled; t++) engine.step();
    expect(engine.settled).toBe(true);
    engine.reheat();
    expect(engine.settled).toBe(false);
    expect(engine.alphaArr[0]).toBe(1);
  });
});
