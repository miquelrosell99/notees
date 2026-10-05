/**
 * The §34.85 follow-up modules: fixed layouts (deterministic radial
 * placements), the orphan filter, temporal sparsification, the minimap
 * coordinate math, and QueryAST color-group evaluation.
 */

import { describe, expect, it } from "vitest";

import type { GraphTopology } from "@notees/store";

import { computeFixedLayout } from "../src/ui/views/graph/layouts.js";
import { GraphMinimap } from "../src/ui/views/graph/minimap.js";
import { evaluateColorGroups } from "../src/ui/views/graph/colorGroups.js";
import { DEFAULT_GRAPH_SETTINGS, applyGraphSettings, sparsifySemantic } from "../src/ui/views/graph/filter.js";
import type { AnyClient } from "../src/ui/views/types.js";

function topo(ids: string[], parentOf: Record<string, string> = {}, edges: GraphTopology["edges"] = []): GraphTopology {
  return {
    nodes: ids.map((id) => ({
      id,
      isClass: false,
      parentId: parentOf[id] ?? null,
      classIds: [],
      color: null,
      icon: null,
    })),
    edges,
  };
}

describe("fixed layouts", () => {
  it("circle: every node placed, deterministic, on one ring", () => {
    const t = topo(["a", "b", "c", "d"]);
    const a = computeFixedLayout("circle", t);
    const b = computeFixedLayout("circle", t);
    expect(a.size).toBe(4);
    for (const [id, p] of a) {
      expect(p.x).toBeCloseTo(b.get(id)!.x, 10);
      const r = Math.hypot(p.x, p.y);
      expect(r).toBeCloseTo(Math.hypot(a.get("a")!.x, a.get("a")!.y), 5);
    }
  });

  it("tree: children sit one ring out from their parent", () => {
    const t = topo(["root", "k1", "k2", "g1"], { k1: "root", k2: "root", g1: "k1" });
    const pts = computeFixedLayout("tree", t);
    const r = (id: string): number => Math.hypot(pts.get(id)!.x, pts.get(id)!.y);
    expect(r("k1")).toBeGreaterThan(r("root"));
    expect(r("k2")).toBeGreaterThan(r("root"));
    expect(r("g1")).toBeGreaterThan(r("k1"));
  });

  it("tree: nodes whose parent is hidden become roots (no orphans lost)", () => {
    const t = topo(["a", "b"], { b: "missing" });
    const pts = computeFixedLayout("tree", t);
    expect(pts.size).toBe(2);
  });
});

describe("orphan filter", () => {
  it("hides nodes with no visible edges when showOrphans is off", () => {
    const t = topo(["a", "b", "lonely"], {}, [
      { kind: "mention", source: "a", target: "b", weight: 1, evidence: null },
    ]);
    const withOrphans = applyGraphSettings(t, DEFAULT_GRAPH_SETTINGS);
    expect(withOrphans.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "lonely"]);
    const without = applyGraphSettings(t, { ...DEFAULT_GRAPH_SETTINGS, showOrphans: false });
    expect(without.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
  });
});

describe("temporal sparsification", () => {
  it("sparsifies temporal edges independently from semantic", () => {
    const edges = [
      { kind: "temporal" as const, source: "a", target: "b", weight: 9, evidence: null },
      { kind: "temporal" as const, source: "a", target: "c", weight: 1, evidence: null },
      { kind: "semantic" as const, source: "a", target: "b", weight: 5, evidence: null },
    ];
    // minWeight 2: the weight-1 temporal edge is cut in both families.
    expect(sparsifySemantic(edges, 1, 2, "temporal").map((e) => e.target)).toEqual(["b"]);
    expect(sparsifySemantic(edges, 1, 2, "semantic").map((e) => e.target)).toEqual(["b"]);
  });
});

describe("minimap math", () => {
  it("screenToWorld inverts the draw's mapping", () => {
    const positions = new Float32Array([0, 0, 100, 50, -100, -50]);
    const frame = { positions, nodeIds: ["a", "b", "c"], nodeCount: 3 };
    const cam = { x: 0, y: 0, zoom: 1 };
    // The center of the minimap maps back to the world's bounding center.
    const world = GraphMinimap.screenToWorld(100, 70, 200, 140, frame, cam);
    expect(world.x).toBeCloseTo(0, 5);
    expect(world.y).toBeCloseTo(0, 5);
  });
});

describe("color groups", () => {
  it("first match wins; invalid queries skipped; empty queries match nothing", async () => {
    const fakeClient = {
      listClasses: () => [
        { id: "c-books", name: "books" },
        { id: "c-red", name: "red" },
      ],
      listPropertySchemas: () => [],
      resolveNodeByName: () => null,
      runQueryAst: (ast: unknown) => {
        const text = JSON.stringify(ast);
        if (text.includes("c-books")) return { ids: ["n1", "n2"] };
        if (text.includes("c-red")) return { ids: ["n2", "n3"] };
        return { ids: ["n9"] };
      },
    } as unknown as AnyClient;
    const groups = [
      { id: "1", label: "Books", color: "sky", query: "class:books" },
      { id: "2", label: "Red", color: "rose", query: "class:red" },
      { id: "3", label: "Broken", color: "mint", query: "class:nope-not-a-class" },
      { id: "4", label: "Empty", color: "mint", query: "  " },
    ];
    const colors = await evaluateColorGroups(fakeClient, groups, (c) => `#${c}`);
    expect(colors.get("n1")).toBe("#sky");
    expect(colors.get("n2")).toBe("#sky"); // first match wins
    expect(colors.get("n3")).toBe("#rose");
    expect(colors.has("n9")).toBe(false); // group 3's query does not resolve; group 4 is empty
  });
});
