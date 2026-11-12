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
  planDiscCenters,
  type GraphEngineEdge,
  type GraphEngineNode,
} from "../src/features/collection/graph/engine/index.js";

function physics(overrides: Partial<Parameters<typeof buildGraphEngineConfig>[0]> = {}) {
  return buildGraphEngineConfig({ preset: "balanced", centralGravity: 30, linkCountAttraction: false, clustering: true, ...overrides });
}

function chain(count: number): { nodes: GraphEngineNode[]; edges: GraphEngineEdge[] } {
  const nodes = Array.from({ length: count }, (_, i) => ({ nodeUuid: `n${i}` }));
  const edges = Array.from({ length: count - 1 }, (_, i) => ({ source: `n${i}`, target: `n${i + 1}` }));
  return { nodes, edges };
}

/**
 * Two planted-partition communities (dense parent-typed internals, ~8 edges
 * per node) bridged by a single loose cooccurrence link. Circulant-only
 * fixtures are expanders — modularity has no structure to find in them — so
 * the fixture carries real community signal.
 */
function twoClusters(): { nodes: GraphEngineNode[]; edges: GraphEngineEdge[] } {
  const size = 30;
  const nodes = Array.from({ length: size * 2 }, (_, i) => ({ nodeUuid: `n${i}` }));
  const edges: GraphEngineEdge[] = [];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (const base of [0, size]) {
    for (let i = 0; i < size; i++) {
      for (let d = 1; d <= 4; d++) {
        edges.push({ source: `n${base + i}`, target: `n${base + ((i + d) % size)}`, type: "parent" });
      }
      for (let k = 0; k < 4; k++) {
        const j = Math.floor(rnd() * size);
        if (j !== i) edges.push({ source: `n${base + i}`, target: `n${base + j}`, type: "parent" });
      }
    }
  }
  edges.push({ source: "n0", target: `n${size}`, type: "cooccurrence" });
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

  it("a warm start (initialAlpha 0.2) cools sooner and moves far less than a fresh one", () => {
    // cached workspaces seed the engine at 0.2 activity so
    // the map opens nearly still instead of re-enacting the full unfold.
    const { nodes, edges } = chain(80);
    const mk = (initialAlpha?: number): GraphEngine =>
      new GraphEngine(nodes, edges, physics(initialAlpha === undefined ? {} : { initialAlpha }));
    const settleAt = (engine: GraphEngine): number => {
      for (let t = 0; t < 4000; t++) {
        engine.step();
        if (engine.settled) return t;
      }
      return -1;
    };
    const freshSettleAt = settleAt(mk());
    const warmSettleAt = settleAt(mk(0.2));
    expect(freshSettleAt).toBeGreaterThan(0);
    expect(warmSettleAt).toBeGreaterThan(0);
    expect(warmSettleAt).toBeLessThan(freshSettleAt);

    // Amplitude: the 0.2 activity scales every force — over the first 100
    // ticks the warm graph's total drift is a fraction of the fresh unfold
    // (measured ~36%), the "opens nearly still" the owner asked for.
    const driftOver = (engine: GraphEngine, ticks: number): number => {
      const s0 = engine.getState();
      const beforeX = new Float32Array(s0.posX);
      const beforeY = new Float32Array(s0.posY);
      let drift = 0;
      for (let t = 0; t < ticks; t++) {
        engine.step();
        const s = engine.getState();
        for (let i = 0; i < s.nodeCount; i++) {
          drift += Math.hypot(s.posX[i]! - beforeX[i]!, s.posY[i]! - beforeY[i]!);
        }
      }
      return drift;
    };
    const freshDrift = driftOver(mk(), 100);
    const warmDrift = driftOver(mk(0.2), 100);
    expect(warmDrift).toBeLessThan(freshDrift * 0.6);
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

  it("two bridged communities stay detected as two clusters", () => {
    const { nodes, edges } = twoClusters();
    const half = nodes.length / 2;
    const engine = new GraphEngine(nodes, edges, physics());
    const state = engine.getState();
    const clOf = (uuid: string) => engine.clIdArr[state.nodeIdArr.indexOf(uuid)]!;
    const clA = clOf("n0");
    const clB = clOf(`n${half}`);
    // The cooccurrence bridge must not merge the communities.
    expect(clA).not.toBe(clB);
    // Each community stays intact in its own cluster.
    const bodyOf = (base: number, cl: number) => {
      let inCl = 0;
      for (let i = 0; i < half; i++) if (clOf(`n${base + i}`) === cl) inCl++;
      return inCl;
    };
    expect(bodyOf(0, clA)).toBe(half);
    expect(bodyOf(half, clB)).toBe(half);
  });

  it("cluster separation: bridged communities end with clear space between surfaces", () => {
    const { nodes, edges } = twoClusters();
    const half = nodes.length / 2;
    // Gravity off: this test pins pure force balance between the soft shell
    // (push apart) and the bridge springs (pull together).
    const engine = new GraphEngine(nodes, edges, physics({ centralGravity: 0 }));
    for (let t = 0; t < 6000 && !engine.settled; t++) engine.step();
    expect(engine.settled).toBe(true);

    const centroid = (from: number, to: number): { x: number; y: number } => {
      let x = 0, y = 0;
      for (let i = from; i < to; i++) {
        const p = engine.getNodePosition(nodes[i]!.nodeUuid)!;
        x += p.x; y += p.y;
      }
      return { x: x / (to - from), y: y / (to - from) };
    };
    const a = centroid(0, half);
    const b = centroid(half, nodes.length);
    const dist = Math.hypot(a.x - b.x, a.y - b.y);

    // Shell radii for 30-node communities at the balanced ideal distance.
    const r = Math.min(100 * 0.5 * Math.sqrt(half), 100 * 6);
    // The communities' surfaces must not interpenetrate.
    expect(dist).toBeGreaterThan(2 * r);
  });

  it("cluster separation survives the default central gravity", () => {
    const { nodes, edges } = twoClusters();
    const half = nodes.length / 2;
    const engine = new GraphEngine(nodes, edges, physics());
    for (let t = 0; t < 8000 && !engine.settled; t++) engine.step();
    expect(engine.settled).toBe(true);
    const centroid = (from: number, to: number): { x: number; y: number } => {
      let x = 0, y = 0;
      for (let i = from; i < to; i++) {
        const p = engine.getNodePosition(nodes[i]!.nodeUuid)!;
        x += p.x; y += p.y;
      }
      return { x: x / (to - from), y: y / (to - from) };
    };
    const a = centroid(0, half);
    const b = centroid(half, nodes.length);
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const r = Math.min(100 * 0.5 * Math.sqrt(half), 100 * 6);
    // Gravity caps the separation, but the surfaces must still clear.
    expect(dist).toBeGreaterThan(1.5 * r);
  });

  describe("seed placement (the explosion fix)", () => {
    it("planDiscCenters never overlaps big discs and anchors the largest at the center", () => {
      const items = [
        { count: 400, rad: 600 }, // rank 0 — the giant
        { count: 300, rad: 500 },
        { count: 200, rad: 400 },
        { count: 3, rad: 90 },
        { count: 1, rad: 0 },
        { count: 1, rad: 0 },
      ];
      const { offsets } = planDiscCenters(items, {
        bigMargin: 560,
        midShell: 560,
        tightShell: 40,
        angle0: 0.7,
      });
      const at = (i: number) => ({ x: offsets[i * 2]!, y: offsets[i * 2 + 1]! });
      const dist = (a: number, b: number) => Math.hypot(at(a).x - at(b).x, at(a).y - at(b).y);
      // The largest disc sits at the group's center.
      expect(Math.hypot(at(0).x, at(0).y)).toBe(0);
      // Any two big discs keep a full surface margin between them.
      for (const [a, b] of [[0, 1], [0, 2], [1, 2]] as const) {
        expect(dist(a, b)).toBeGreaterThanOrEqual(items[a]!.rad + items[b]!.rad + 560 - 1e-3);
      }
      // Deterministic for the same inputs.
      const again = planDiscCenters(items, { bigMargin: 560, midShell: 560, tightShell: 40, angle0: 0.7 });
      expect([...again.offsets]).toEqual([...offsets]);
    });

    it("bridged communities are seeded with clear space between their discs", () => {
      const { nodes, edges } = twoClusters();
      const half = nodes.length / 2;
      const engine = new GraphEngine(nodes, edges, physics());
      const centroid = (from: number, to: number): { x: number; y: number } => {
        let x = 0, y = 0;
        for (let i = from; i < to; i++) {
          const p = engine.getNodePosition(nodes[i]!.nodeUuid)!;
          x += p.x; y += p.y;
        }
        return { x: x / (to - from), y: y / (to - from) };
      };
      const a = centroid(0, half);
      const b = centroid(half, nodes.length);
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      // Two 30-node communities: disc surfaces at least the cluster margin
      // apart at seed time (the piled-up seed was the layout bomb — thousands
      // of overlapping nodes summed their repulsion to the velocity clamp and
      // the graph spent its whole alpha budget in flight).
      const r = Math.min(100 * 0.5 * Math.sqrt(half), 100 * 6);
      const clusterMargin = 350 * (0.5 + (65 / 100) * 1.5); // balanced + sep 65
      expect(dist).toBeGreaterThan(2 * r + clusterMargin * 0.9);
    });

    it("an orphan-heavy graph settles calm and bounded — no explosion, no stray far field", () => {
      // One chain component + 500 orphan singletons: the workspace shape that
      // used to open as a 100k-unit scatter of frozen mid-flight nodes.
      const { nodes, edges } = chain(80);
      const orphans: GraphEngineNode[] = Array.from({ length: 500 }, (_, i) => ({
        nodeUuid: `o${i}`,
      }));
      const engine = new GraphEngine([...nodes, ...orphans], edges, physics());
      let seedMaxR = 0;
      for (const nd of [...nodes, ...orphans]) {
        const p = engine.getNodePosition(nd.nodeUuid)!;
        seedMaxR = Math.max(seedMaxR, Math.hypot(p.x, p.y));
      }
      for (let t = 0; t < 4000 && !engine.settled; t++) engine.step();
      expect(engine.settled).toBe(true);
      const s = engine.getState();
      let maxR = 0;
      for (let i = 0; i < s.nodeCount; i++) {
        expect(Number.isFinite(s.posX[i])).toBe(true);
        maxR = Math.max(maxR, Math.hypot(s.posX[i]!, s.posY[i]!));
      }
      // Nothing flies past its seed radius — settling contracts, never blasts.
      expect(maxR).toBeLessThanOrEqual(seedMaxR + 500);
    });

    it("small components settle fully relaxed — edges at rest, not frozen mid-flight", () => {
      // Star components of 2–6 nodes (the screenshot-constellation shape):
      // a relaxed settle parks every internal edge within ~1.4× rest length.
      const nodes: GraphEngineNode[] = [];
      const edges: GraphEngineEdge[] = [];
      for (let c = 0; c < 24; c++) {
        const size = 2 + (c % 5);
        const hub = `h${c}`;
        nodes.push({ nodeUuid: hub });
        for (let k = 1; k < size; k++) {
          const leaf = `h${c}l${k}`;
          nodes.push({ nodeUuid: leaf });
          edges.push({ source: hub, target: leaf, type: "parent" });
        }
      }
      const engine = new GraphEngine(nodes, edges, physics());
      for (let t = 0; t < 4000 && !engine.settled; t++) engine.step();
      expect(engine.settled).toBe(true);
      const s = engine.getState();
      const idx = new Map(s.nodeIdArr.map((id, i) => [id, i]));
      let sum = 0;
      let worst = 0;
      for (let ei = 0; ei < engine.numEdges; ei++) {
        const si = idx.get(s.nodeIdArr[engine.edgeSrc[ei]!]!)!;
        const ti = idx.get(s.nodeIdArr[engine.edgeTgt[ei]!]!)!;
        const ratio =
          Math.hypot(s.posX[si]! - s.posX[ti]!, s.posY[si]! - s.posY[ti]!) / engine.edgeRest[ei]!;
        sum += ratio;
        worst = Math.max(worst, ratio);
      }
      expect(sum / engine.numEdges).toBeLessThan(1.4);
      expect(worst).toBeLessThan(2.2);
    });
  });
});
