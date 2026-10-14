/**
 * graph/renderer Pixi adapter tests — the pure logic ported from the WebGL
 * renderer (hover recolor, LOD mask, min-radius clamp, time-lapse discard,
 * LOD edge gating, edge-curve sampling, camera/pick math) plus a mocked-
 * Application construction/render smoke spec. Real GPU contexts don't exist
 * in jsdom — same test boundary as the WebGL suite.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("pixi.js", () => {
  class MockPoint {
    x = 0;
    y = 0;
    set(x: number, y: number): this {
      this.x = x;
      this.y = y;
      return this;
    }
  }
  class MockContainer {
    children: unknown[] = [];
    position = new MockPoint();
    scale = new MockPoint();
    addChild(...c: unknown[]): this {
      this.children.push(...c);
      return this;
    }
    removeChild(...c: unknown[]): this {
      this.children = this.children.filter((x) => !c.includes(x));
      return this;
    }
  }
  class MockGraphics extends MockContainer {
    strokes: unknown[] = [];
    fills: unknown[] = [];
    moveTo(): this {
      return this;
    }
    lineTo(): this {
      return this;
    }
    circle(): this {
      return this;
    }
    poly(): this {
      return this;
    }
    fill(style?: unknown): this {
      this.fills.push(style);
      return this;
    }
    stroke(style?: unknown): this {
      this.strokes.push(style);
      return this;
    }
    clear(): this {
      this.strokes = [];
      this.fills = [];
      return this;
    }
    destroy(): void {}
  }
  class MockSprite {
    anchor = new MockPoint();
    position = new MockPoint();
    scale = new MockPoint();
    tint = 0xffffff;
    alpha = 1;
    visible = true;
    constructor(_texture?: unknown) {}
    destroy(): void {}
  }
  class MockApp {
    stage = new MockContainer();
    renderer = {
      resize: vi.fn(),
      extract: { texture: vi.fn(() => ({ destroy: vi.fn() })) },
    };
    init = vi.fn(async () => {});
    render = vi.fn();
    destroy = vi.fn();
  }
  return {
    Application: MockApp,
    Container: MockContainer,
    Graphics: MockGraphics,
    Sprite: MockSprite,
  };
});

import {
  GraphPixiRenderer,
  hoverTintRgb,
  linkTypeVisible,
  nodeEffectiveRadius,
  sampleEdgePoints,
  shouldDrawEdgesAtLod,
  timeLapseVisible,
} from "../src/ui/views/graph/renderer/pixiRenderer.js";

const ACCENT: readonly [number, number, number] = [0.1, 0.2, 0.3];

describe("hoverTintRgb (the owner 2026-10-14 pure-color ruling)", () => {
  const base: readonly [number, number, number] = [0.5, 0.25, 1.0];

  it("inactive hover returns the base untouched", () => {
    expect(hoverTintRgb(base, 0, false, ACCENT, 2)).toEqual([0.5, 0.25, 1.0]);
    expect(hoverTintRgb(base, 2, false, ACCENT, 2)).toEqual([0.5, 0.25, 1.0]);
  });

  it("nodes: hovered (2) fills the accent, neighbors (1) keep their color, outside (0) darkens 20%", () => {
    expect(hoverTintRgb(base, 2, true, ACCENT, 2)).toEqual([0.1, 0.2, 0.3]);
    expect(hoverTintRgb(base, 1, true, ACCENT, 2)).toEqual([0.5, 0.25, 1.0]);
    expect(hoverTintRgb(base, 0, true, ACCENT, 2)).toEqual([0.4, 0.2, 0.8]);
  });

  it("edges: incident (1) paints the accent, non-incident (0) darkens 20% (accent level 1)", () => {
    expect(hoverTintRgb(base, 1, true, ACCENT, 1)).toEqual([0.1, 0.2, 0.3]);
    expect(hoverTintRgb(base, 0, true, ACCENT, 1)).toEqual([0.4, 0.2, 0.8]);
  });
});

describe("LOD mask + gating helpers", () => {
  it("linkTypeVisible mirrors the shader bit test", () => {
    expect(linkTypeVisible(0, 0xffffffff)).toBe(true);
    expect(linkTypeVisible(7, 0xffffffff)).toBe(true);
    expect(linkTypeVisible(1, ~(1 << 1))).toBe(false);
    expect(linkTypeVisible(5, (1 << 5) | (1 << 2))).toBe(true);
    expect(linkTypeVisible(3, (1 << 5) | (1 << 2))).toBe(false);
  });

  it("constellation LOD (0) skips edges unless a hover is active", () => {
    expect(shouldDrawEdgesAtLod(0, false)).toBe(false);
    expect(shouldDrawEdgesAtLod(0, true)).toBe(true);
    expect(shouldDrawEdgesAtLod(1, false)).toBe(true);
    expect(shouldDrawEdgesAtLod(2, false)).toBe(true);
  });
});

describe("node min-radius clamp + time-lapse discard", () => {
  it("nodeEffectiveRadius applies the GL min-screen-radius clamp at low zoom", () => {
    expect(nodeEffectiveRadius(8, 1.0, 3)).toBe(8);
    // zoom 0.1 → min world radius = 3 / (2 × 0.1) = 15 > 8
    expect(nodeEffectiveRadius(8, 0.1, 3)).toBe(15);
    expect(nodeEffectiveRadius(8, 0.1, 3)).toBeCloseTo(3 / (2 * 0.1), 6);
  });

  it("timeLapseVisible hides only post-cutoff stamps while enabled", () => {
    expect(timeLapseVisible(1_000, true, 1_500)).toBe(true);
    expect(timeLapseVisible(2_000, true, 1_500)).toBe(false);
    // The un-stamped marker never hides.
    expect(timeLapseVisible(-Infinity, true, 1_500)).toBe(true);
    // Disabled is the neutral path.
    expect(timeLapseVisible(2_000, false, 1_500)).toBe(true);
    // The cutoff itself stays visible (strictly-greater rule).
    expect(timeLapseVisible(1_500, true, 1_500)).toBe(true);
  });
});

describe("sampleEdgePoints (the GL curve math)", () => {
  it("a straight edge samples onto the segment", () => {
    const pts = sampleEdgePoints(0, 0, 100, 0, 0, 0, 1.0, 16);
    expect(pts.length).toBe(17 * 2);
    expect(pts[0]).toBe(0);
    expect(pts[1]).toBe(0);
    expect(pts[32]).toBe(100);
    expect(pts[33]).toBe(0);
    // Every sample lies on the chord.
    for (let s = 1; s < 16; s++) {
      expect(pts[s * 2 + 1]).toBeCloseTo(0, 4);
      expect(pts[s * 2]).toBeCloseTo((100 * s) / 16, 4);
    }
  });

  it("a curved edge (reference curvature) bows off the chord and returns to it", () => {
    const pts = sampleEdgePoints(0, 0, 100, 0, 0.25, 3, 1.0, 16);
    expect(pts[0]).toBe(0);
    expect(pts[32]).toBe(100);
    // Midpoint bows along the perpendicular (y), zero at both ends.
    expect(pts[17]).toBeCloseTo(0.25 * 100, 1); // sin(π/2) × curvature × len
    expect(Math.abs(pts[17]!)).toBeGreaterThan(10);
  });

  it("a class link (linkType 1) wiggles with the 3/zoom sine amplitude", () => {
    const zoom = 2.0;
    const pts = sampleEdgePoints(0, 0, 100, 0, 0, 1, zoom, 16);
    expect(pts[0]).toBe(0);
    expect(pts[32]).toBe(100);
    // t = 1/16 → sin(8π/16) = sin(π/2) = 1 → full 3/zoom offset on the perp.
    expect(pts[3]).toBeCloseTo(3 / zoom, 4);
    // t = 1/2 → sin(4π) = 0 → back on the chord.
    expect(pts[17]).toBeCloseTo(0, 4);
  });
});

describe("camera math + picking without a GPU", () => {
  function mathRenderer() {
    const r = new GraphPixiRenderer();
    r.resize(800, 600);
    return r;
  }

  it("worldToScreen / screenToWorld round-trip", () => {
    const r = mathRenderer();
    r.setCamera(10, 20, 1.5);
    const screen = r.worldToScreen(4, -8);
    expect(screen.x).toBeCloseTo((4 - 10) * 1.5 + 400, 4);
    expect(screen.y).toBeCloseTo((-8 - 20) * 1.5 + 300, 4);
    const world = r.screenToWorld(screen.x, screen.y);
    expect(world.x).toBeCloseTo(4, 4);
    expect(world.y).toBeCloseTo(-8, 4);
  });

  it("fitToCanvas frames the bbox with padding and the zoom clamp", () => {
    const r = mathRenderer();
    r.setNodeVisuals(["a", "b", "c"], new Map());
    r.updatePositions(new Float32Array([0, 0, 100, 0, 0, 100]), ["a", "b", "c"]);
    const cam = r.fitToCanvas(60);
    expect(cam.x).toBeCloseTo(50, 4);
    expect(cam.y).toBeCloseTo(50, 4);
    // world 100+2×16 padded into 680×480 → zoom ≈ 4.8, inside the clamp.
    expect(cam.zoom).toBeGreaterThan(0.02);
    expect(cam.zoom).toBeLessThanOrEqual(40);
  });

  it("pickNode / pickEdge scan the latest positions", () => {
    const r = mathRenderer();
    r.setNodeVisuals(["a", "b", "c"], new Map());
    r.updatePositions(new Float32Array([0, 0, 100, 0, 50, 100]), ["a", "b", "c"]);
    r.setEdges([{ source: "a", target: "b", linkType: 0 }]);
    expect(r.pickNode(3, 4, 20)).toBe("a"); // dist 5 < 20
    expect(r.pickNode(50, 100, 10)).toBe("c");
    expect(r.pickNode(500, 500, 10)).toBeNull();
    expect(r.pickEdge(50, 1, 5)).toBe(0); // near the a→b segment
    expect(r.pickEdge(50, 90, 2)).toBe(-1);
  });
});

describe("mocked-Application smoke (init → data → render → destroy)", () => {
  function stubWebgl2(): void {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      ((type: string) => (type === "webgl2" ? {} : null)) as typeof HTMLCanvasElement.prototype.getContext,
    );
  }

  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it("throws the honest error when WebGL2 is unavailable", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      (() => null) as typeof HTMLCanvasElement.prototype.getContext,
    );
    const renderer = new GraphPixiRenderer();
    expect(() => renderer.init(document.createElement("canvas"))).toThrow("WebGL2 not supported");
    vi.restoreAllMocks();
  });

  it("renders nodes, edges, and arrowheads through the mocked stack", async () => {
    stubWebgl2();
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    const renderer = new GraphPixiRenderer({ defaultRadius: 8, edgeWidth: 0.8 });
    renderer.init(canvas);
    const app = (renderer as unknown as { app: import("pixi.js").Application }).app;
    await flush();
    await flush();

    renderer.setNodeVisuals(
      ["a", "b"],
      new Map([["a", { radius: 8, color: new Float32Array([1, 0, 0, 1]) }]]),
    );
    renderer.updatePositions(new Float32Array([0, 0, 100, 0]), ["a", "b"]);
    renderer.setEdges([
      { source: "a", target: "b", linkType: 0 }, // parent → one arrowhead
      { source: "b", target: "a", linkType: 3 }, // reference → no arrowhead
    ]);
    renderer.setCamera(50, 0, 1);
    renderer.render();

    expect(app.render).toHaveBeenCalled();
    expect(renderer.stats.nodeInstCount).toBe(2);
    expect(renderer.stats.edgeInstCount).toBe(2);
    expect(renderer.stats.arrowInstCount).toBe(1);
    // The world container carries the camera as a GPU transform.
    const world = (renderer as unknown as { world: { scale: { x: number; y: number } } }).world;
    expect(world.scale.x).toBe(1);
    expect(world.scale.y).toBe(-1); // the GL NDC y-flip

    renderer.destroy();
    expect(app.destroy).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("time-lapse hides post-cutoff nodes and edges", async () => {
    stubWebgl2();
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    const renderer = new GraphPixiRenderer();
    renderer.init(canvas);
    await flush();
    await flush();

    renderer.setNodeVisuals(["old", "new"], new Map());
    renderer.updatePositions(new Float32Array([0, 0, 100, 0]), ["old", "new"]);
    renderer.setNodeTimes(new Float32Array([1_000, 2_000]));
    renderer.setEdges([
      { source: "old", target: "new", linkType: 0, createdAt: 2_000 },
    ]);
    renderer.setTimeLapse(true, 1_500);
    renderer.setCamera(50, 0, 1);
    renderer.render();

    const sprites = (renderer as unknown as { spriteByIndex: Array<{ visible: boolean }> })
      .spriteByIndex;
    expect(sprites[0]!.visible).toBe(true);
    expect(sprites[1]!.visible).toBe(false); // created after the cutoff
    expect(renderer.stats.edgeInstCount).toBe(0); // its only edge is post-cutoff too
    vi.restoreAllMocks();
  });
});
