/**
 * graph sizing tests: the v1 node-radius curve (four size modes, link
 * direction), the color precedence (class colors beat query groups beat the
 * node's own color), and engine mass accumulation (heavy parents accelerate
 * slower). Pure logic — no canvas.
 */

import { describe, expect, it } from "vitest";

import {
  NODE_RADIUS_MAX,
  NODE_RADIUS_MIN,
  computeNodeSizing,
  nodeRadius,
  type LinkDirection,
  type NodeSizeMode,
} from "../src/ui/views/graph/nodeRadius.js";
import {
  buildNodeVisuals,
  classColorFor,
  resolveNodeColorRgb,
  type ClassColorEntry,
} from "../src/ui/views/graph/nodeVisuals.js";
import {
  GraphEngine,
  buildGraphEngineConfig,
  type GraphEngineNode,
} from "../src/ui/views/graph/engine/index.js";

const node = (id: string, extra: Partial<{ contentSize: number; mass: number; classIds: string[]; color: string | null }> = {}) => ({
  id,
  isClass: false,
  parentId: null,
  classIds: [] as string[],
  color: null,
  icon: null,
  contentSize: 0,
  mass: 1,
  ...extra,
});

const degrees = { all: 0, in: 0, out: 0 };
const maxima = { connections: 10, mass: 11, content: 100 };

describe("node radius (the v1 curve)", () => {
  it("uniform rides the base radius", () => {
    expect(nodeRadius("uniform", 8, node("a"), degrees, maxima, "all")).toBe(8);
    expect(nodeRadius("uniform", 20, node("a"), degrees, maxima, "all")).toBe(20);
  });

  it("metric modes span the v1 bounds and hit the max at ratio 1", () => {
    for (const mode of ["connections", "mass", "content"] as NodeSizeMode[]) {
      const zero = nodeRadius(mode, 8, node("a", { mass: 1, contentSize: 0 }), degrees, maxima, "all");
      expect(zero).toBe(NODE_RADIUS_MIN);
    }
    const maxConn = nodeRadius("connections", 8, node("a"), { all: 10, in: 10, out: 10 }, maxima, "all");
    expect(maxConn).toBeCloseTo(NODE_RADIUS_MAX, 6);
  });

  it("link direction picks the degree arm", () => {
    const d = { all: 8, in: 2, out: 10 };
    const all = nodeRadius("connections", 8, node("a"), d, { ...maxima, connections: 10 }, "all");
    const incoming = nodeRadius("connections", 8, node("a"), d, { ...maxima, connections: 10 }, "in");
    const outgoing = nodeRadius("connections", 8, node("a"), d, { ...maxima, connections: 10 }, "out");
    expect(incoming).toBeLessThan(all);
    expect(outgoing).toBe(NODE_RADIUS_MAX);
  });

  it("computeNodeSizing derives directed degrees with the edges", () => {
    const { radii, degrees: degs } = computeNodeSizing(
      {
        nodes: [node("a"), node("b"), node("c", { mass: 6, contentSize: 50 })],
        edges: [
          { source: "a", target: "b", kind: "mention", weight: 1, evidence: null },
          { source: "c", target: "a", kind: "mention", weight: 1, evidence: null },
          { source: "c", target: "a", kind: "parent", weight: 1, evidence: null },
        ],
      },
      "connections",
      8,
      "all",
    );
    expect(degs.get("a")).toEqual({ all: 3, in: 2, out: 1 });
    expect(degs.get("c")).toEqual({ all: 2, in: 0, out: 2 });
    // a has the max degree → the max radius; b (degree 1) sits between the
    // bounds; a zero-degree node would take the MIN.
    expect(radii.get("a")).toBeCloseTo(NODE_RADIUS_MAX, 6);
    const rB = radii.get("b")!;
    expect(rB).toBeGreaterThan(NODE_RADIUS_MIN);
    expect(rB).toBeLessThan(NODE_RADIUS_MAX);
  });
});

describe("node color precedence", () => {
  const classColors: ClassColorEntry[] = [
    { classId: "class-a", color: "#ff0000" },
    { classId: "class-b", color: "#00ff00" },
  ];
  const hexToRgba = (hex: string): [number, number, number, number] | undefined => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    return m === null ? undefined : [parseInt(m[1]!.slice(0, 2), 16) / 255, parseInt(m[1]!.slice(2, 4), 16) / 255, parseInt(m[1]!.slice(4, 6), 16) / 255, 1];
  };
  const resolveCss = (c: string): string => c;

  it("class colors apply first match by list order", () => {
    expect(classColorFor(node("n", { classIds: ["class-b", "class-a"] }), classColors)).toBe("#ff0000");
    expect(classColorFor(node("n", { classIds: ["class-b"] }), classColors)).toBe("#00ff00");
    expect(classColorFor(node("n", { classIds: ["other"] }), classColors)).toBeUndefined();
  });

  it("precedence: class color > query group > own color > default", () => {
    const both = resolveNodeColorRgb(
      node("n", { classIds: ["class-a"], color: "#0000ff" }),
      classColors,
      new Map([["n", "#123456"]]),
      hexToRgba,
      resolveCss,
    );
    expect(both).toEqual([1, 0, 0, 1]);
    const grouped = resolveNodeColorRgb(node("n", { color: "#0000ff" }), [], new Map([["n", "#123456"]]), hexToRgba, resolveCss);
    expect(grouped).toEqual([0x12 / 255, 0x34 / 255, 0x56 / 255, 1]);
    const own = resolveNodeColorRgb(node("n", { color: "#0000ff" }), [], new Map(), hexToRgba, resolveCss);
    expect(own).toEqual([0, 0, 1, 1]);
    expect(resolveNodeColorRgb(node("n"), [], new Map(), hexToRgba, resolveCss)).toBeUndefined();
  });

  it("buildNodeVisuals assembles radius + color per node", () => {
    const visuals = buildNodeVisuals(
      { nodes: [node("n", { classIds: ["class-a"] })] },
      new Map([["n", 12]]),
      classColors,
      new Map(),
      hexToRgba,
      resolveCss,
    );
    expect(visuals.get("n")!.radius).toBe(12);
    expect(visuals.get("n")!.color).toBeDefined();
  });
});

describe("engine mass accumulation", () => {
  it("with mass on, a heavy node accelerates slower", () => {
    const massCfg = buildGraphEngineConfig({ preset: "balanced", centralGravity: 30, linkCountAttraction: false, clustering: true, massAccumulation: true });
    const flatCfg = buildGraphEngineConfig({ preset: "balanced", centralGravity: 30, linkCountAttraction: false, clustering: true, massAccumulation: false });
    // A lone node feels only the center gravity — no springs, no repulsion.
    const nodes: GraphEngineNode[] = [{ nodeUuid: "heavy", mass: 9 }];
    const withMass = new GraphEngine(nodes, [], massCfg);
    const withoutMass = new GraphEngine(nodes, [], flatCfg);
    for (let i = 0; i < 30; i++) {
      withMass.step();
      withoutMass.step();
    }
    const distOf = (e: GraphEngine): number => Math.hypot(e.getState().posX[0]!, e.getState().posY[0]!);
    // Identical seeds → identical spiral starts; the mass-9 node under mass
    // accumulation must have covered less ground toward the origin.
    expect(distOf(withMass)).toBeGreaterThan(distOf(withoutMass));
  });

  it("mass defaults to 1 when a node omits it", () => {
    const engine = new GraphEngine(
      [{ nodeUuid: "solo" }],
      [],
      buildGraphEngineConfig({ preset: "balanced", centralGravity: 30, linkCountAttraction: false, clustering: true, massAccumulation: true }),
    );
    engine.step();
    expect(Number.isFinite(engine.getState().posX[0]!)).toBe(true);
  });
});
