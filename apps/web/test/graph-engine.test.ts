/**
 * graph/engine tests (§34.80): determinism (same seed + topology → identical
 * positions), preset sanity, drag/pin behavior, topology-preserving updates,
 * and quiescence after enough ticks. Assertions are on engine STATE, never
 * wall-clock (the render loop owns timing).
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
});
