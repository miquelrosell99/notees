/**
 * The graph follow-up modules: fixed layouts (deterministic radial
 * placements), the orphan filter, temporal sparsification, the minimap
 * coordinate math, and QueryAST color-group evaluation.
 */

import { describe, expect, it } from "vitest";

import type { GraphTopology } from "@notees/store";

import { computeFixedLayout } from "../src/ui/views/graph/layouts.js";
import { GraphMinimap } from "../src/ui/views/graph/minimap.js";
import { evaluateColorGroups, isLegacyColorGroup, migrateColorGroup } from "../src/ui/views/graph/colorGroups.js";
import type { Group } from "@notees/query";
import { DEFAULT_GRAPH_SETTINGS, applyGraphSettings, sparsifySemantic } from "../src/ui/views/graph/filter.js";
import {
  GRAPH_ZOOM_FACTOR,
  GRAPH_ZOOM_MAX,
  GRAPH_ZOOM_MIN,
  bboxForNodes,
  clampZoom,
  fitBoundingBoxCamera,
  panByScreenDelta,
  wheelZoomFactor,
  zoomAtCenter,
  zoomAtWorldPoint,
} from "../src/ui/views/graph/cameraMath.js";
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
      createdAt: "2026-10-13T00:00:00.000Z",
      contentSize: 0,
      mass: 1,
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
      { kind: "mention", source: "a", target: "b", weight: 1, evidence: null, createdAt: null },
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
      { kind: "temporal" as const, source: "a", target: "b", weight: 9, evidence: null, createdAt: null },
      { kind: "temporal" as const, source: "a", target: "c", weight: 1, evidence: null, createdAt: null },
      { kind: "semantic" as const, source: "a", target: "b", weight: 5, evidence: null, createdAt: null },
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

  it("minimap scroll-to-zoom anchors the world point under the cursor", () => {
    // The exact composition the minimap wheel handler runs: minimap pixel
    // → world (the minimap's own linear map) → the shared anchored zoom.
    const positions = new Float32Array([0, 0, 100, 50, -100, -50]);
    const frame = { positions, nodeIds: ["a", "b", "c"], nodeCount: 3 };
    const cam = { x: 0, y: 0, zoom: 1 };
    const world = GraphMinimap.screenToWorld(140, 40, 200, 140, frame, cam);
    const zoomedIn = zoomAtWorldPoint(cam, world.x, world.y, wheelZoomFactor(-100));
    expect(zoomedIn.zoom).toBeCloseTo(1.12, 5);
    // The anchored world point lands at the camera center… i.e. zooming at
    // the world point the cursor sits on keeps it under the cursor: the
    // camera moved TOWARD it, proportionally to the zoom change.
    const t = 1 - 1 / GRAPH_ZOOM_FACTOR;
    expect(zoomedIn.x).toBeCloseTo(world.x * t, 5);
    expect(zoomedIn.y).toBeCloseTo(world.y * t, 5);
    const zoomedOut = zoomAtWorldPoint(cam, world.x, world.y, wheelZoomFactor(100));
    expect(zoomedOut.zoom).toBeCloseTo(1 / GRAPH_ZOOM_FACTOR, 5);
  });
});

describe("camera math", () => {
  it("the clamp range is 0.02–40", () => {
    expect(GRAPH_ZOOM_MIN).toBe(0.02);
    expect(GRAPH_ZOOM_MAX).toBe(40);
    expect(clampZoom(0.001)).toBe(0.02);
    expect(clampZoom(100)).toBe(40);
    expect(clampZoom(1)).toBe(1);
  });

  it("center zoom only changes the zoom (the camera IS the canvas center)", () => {
    const cam = { x: 12, y: -8, zoom: 1 };
    const in_ = zoomAtCenter(cam, 1);
    expect(in_).toEqual({ x: 12, y: -8, zoom: GRAPH_ZOOM_FACTOR });
    const out = zoomAtCenter(cam, -1);
    expect(out).toEqual({ x: 12, y: -8, zoom: 1 / GRAPH_ZOOM_FACTOR });
  });

  it("arrow pan converts screen px at the current zoom", () => {
    const cam = { x: 0, y: 0, zoom: 2 };
    const right = panByScreenDelta(cam, 60, 0);
    expect(right.x).toBeCloseTo(30, 5);
    const up = panByScreenDelta(right, 0, -120);
    expect(up.y).toBeCloseTo(-60, 5);
  });

  it("focus fit centers the bbox with padding, clamped", () => {
    const fit = fitBoundingBoxCamera(
      { minX: 0, minY: 0, maxX: 200, maxY: 100 },
      1000,
      800,
      60,
    )!;
    expect(fit.x).toBeCloseTo(100, 5);
    expect(fit.y).toBeCloseTo(50, 5);
    // The 200×100 world box fits with ~60px padding inside 1000×800.
    expect(fit.zoom).toBeGreaterThan(0);
    expect(200 / fit.zoom + 120 / fit.zoom).toBeLessThanOrEqual(1000 + 1e-6);
    expect(100 / fit.zoom + 120 / fit.zoom).toBeLessThanOrEqual(800 + 1e-6);
    // Empty bbox → null (nothing to focus).
    expect(fitBoundingBoxCamera(null, 1000, 800)).toBeNull();
  });

  it("bboxForNodes covers only the wanted ids", () => {
    const positions = new Float32Array([0, 0, 50, 10, -20, 40]);
    const bbox = bboxForNodes(positions, ["a", "b", "c"], new Set(["b", "c"]))!;
    expect(bbox).toEqual({ minX: -20, minY: 10, maxX: 50, maxY: 40 });
    expect(bboxForNodes(positions, ["a", "b", "c"], new Set(["missing"]))).toBeNull();
  });
});

describe("color groups", () => {
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

  const astFor = (classId: string): Group => ({
    type: "group",
    logic: "and",
    children: [{ type: "class", classId }],
  });
  const emptyAst: Group = { type: "group", logic: "and", children: [] };

  it("first match wins; erroneous/empty ASTs match nothing; list order is the priority", async () => {
    const groups = [
      { id: "1", label: "Books", color: "sky", ast: astFor("c-books") },
      { id: "2", label: "Red", color: "rose", ast: astFor("c-red") },
      // Unmigrated legacy group (parse failed at load): painted nowhere.
      { id: "3", label: "Broken", color: "mint", ast: null, error: "unknown class" },
      // Empty builder group: matches nothing.
      { id: "4", label: "Empty", color: "mint", ast: emptyAst },
    ];
    const colors = await evaluateColorGroups(fakeClient, groups, (c) => `#${c}`);
    expect(colors.get("n1")).toBe("#sky");
    expect(colors.get("n2")).toBe("#sky"); // first match wins
    expect(colors.get("n3")).toBe("#rose");
    expect(colors.has("n9")).toBe(false); // group 3 is erroneous; group 4 is empty
  });

  it("the stored list order drives the priority: reordering re-paints", async () => {
    const books = { id: "1", label: "Books", color: "sky", ast: astFor("c-books") };
    const red = { id: "2", label: "Red", color: "rose", ast: astFor("c-red") };
    const skyFirst = await evaluateColorGroups(fakeClient, [books, red], (c) => `#${c}`);
    expect(skyFirst.get("n2")).toBe("#sky");
    const roseFirst = await evaluateColorGroups(fakeClient, [red, books], (c) => `#${c}`);
    expect(roseFirst.get("n2")).toBe("#rose");
  });

  it("legacy DSL strings migrate to ASTs in place; fail-loud parse errors keep the group, marked", () => {
    // A stored pre-AST row (text-DSL query) parses through the DSL parser —
    // names resolve against the workspace — and re-persists as an AST.
    const migrated = migrateColorGroup(fakeClient, {
      id: "1",
      label: "Books",
      color: "sky",
      query: "class:books",
    });
    expect(migrated.ast).toEqual(astFor("c-books"));
    expect(migrated.error).toBeUndefined();

    // An unresolvable query fails loud: the group stays, painted nowhere,
    // the parse error carried for the rail's honest error row.
    const broken = migrateColorGroup(fakeClient, {
      id: "2",
      label: "Broken",
      color: "mint",
      query: "class:nope-not-a-class",
    });
    expect(broken.ast).toBeNull();
    expect(broken.error).toBeTruthy();

    // Already-migrated rows pass through untouched.
    const astRow = { id: "3", label: "Red", color: "rose", ast: astFor("c-red") };
    expect(migrateColorGroup(fakeClient, astRow)).toBe(astRow);
    expect(isLegacyColorGroup(astRow)).toBe(false);
    expect(isLegacyColorGroup({ id: "4", label: "", color: "sky", query: "class:books" })).toBe(true);
  });
});
