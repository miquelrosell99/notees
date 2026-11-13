/**
 * minimap tests — the pure Canvas-2D projection (no GPU): the dots and the
 * viewport rectangle ride ONE linear world→minimap map, and the rect must
 * reflect the true camera view at ANY zoom (the old 0.05 zoom floor drew a
 * rect several times smaller than the real viewport once the camera zoomed
 * out past it — "the minimap rectangle does not correspond to what I see").
 */

import { describe, expect, it } from "vitest";

import { GraphMinimap } from "../src/features/collection/graph/minimap.js";

interface RectCall {
  x: number;
  y: number;
  w: number;
  h: number;
}

function stubCtx() {
  const rects: RectCall[] = [];
  const strokes: RectCall[] = [];
  return {
    rects,
    strokes,
    ctx: {
      clearRect: () => {},
      fillRect: (x: number, y: number, w: number, h: number) => {
        rects.push({ x, y, w, h });
      },
      strokeRect: (x: number, y: number, w: number, h: number) => {
        strokes.push({ x, y, w, h });
      },
    } as unknown as CanvasRenderingContext2D,
  };
}

// A 10k×10k world of two nodes; the main canvas is 1000×500 px.
const positions = new Float32Array([0, 0, 10_000, 10_000]);
const VIEW_W = 1000;
const VIEW_H = 500;

describe("graph minimap", () => {
  it("the viewport rect matches the camera view at ordinary zoom", () => {
    const { ctx, strokes } = stubCtx();
    // zoom 1 → the view is exactly 1000×500 world units.
    GraphMinimap.draw(ctx, 200, 140, positions, [], { x: 5000, y: 5000, zoom: 1 }, VIEW_W, VIEW_H);
    expect(strokes).toHaveLength(1);
    const rect = strokes[0]!;
    // World 10k into 200×140 (the height binds): scale = 0.014×0.92 =
    // 0.01288 px/unit. The 1000×500-unit view becomes ~12.9×6.4 px.
    const scale = (140 / 10_000) * 0.92;
    expect(rect.w).toBeCloseTo(VIEW_W * scale, 4);
    expect(rect.h).toBeCloseTo(VIEW_H * scale, 4);
  });

  it("the viewport rect keeps matching far below the old 0.05 zoom floor", () => {
    const { ctx, strokes } = stubCtx();
    // zoom 0.01 (< the old 0.05 floor): the true view is 100k×50k world
    // units — wider than the whole 10k map — so the rect must span beyond
    // the minimap canvas. The floored zoom drew a 5×-too-small box instead.
    GraphMinimap.draw(ctx, 200, 140, positions, [], { x: 5000, y: 5000, zoom: 0.01 }, VIEW_W, VIEW_H);
    expect(strokes).toHaveLength(1);
    const rect = strokes[0]!;
    expect(rect.w).toBeGreaterThan(200);
    expect(rect.h).toBeGreaterThan(140);
  });

  it("screenToWorld inverts the dot map (click navigation lands where the dot is)", () => {
    // The node at world (10,000, 10,000) maps to minimap pixel
    // (35.6 + 128.8, 5.6 + 128.8) = (164.4, 134.4) — the round trip must
    // land back on the node's world coordinates.
    const scale = (140 / 10_000) * 0.92;
    const px = (200 - 10_000 * scale) / 2 + 10_000 * scale;
    const py = (140 - 10_000 * scale) / 2 + 10_000 * scale;
    const world = GraphMinimap.screenToWorld(px, py, 200, 140, {
      positions,
      nodeIds: ["a", "b"],
      nodeCount: 2,
    }, { x: 0, y: 0, zoom: 1 });
    expect(world.x).toBeCloseTo(10_000, 4);
    expect(world.y).toBeCloseTo(10_000, 4);
  });
});
