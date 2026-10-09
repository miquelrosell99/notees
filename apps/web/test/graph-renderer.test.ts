/**
 * graph/renderer tests: the label overlay contract (zoom caps,
 * truncation, culling, emphasis) and the renderer's honest WebGL2-missing
 * path. Real GL contexts don't exist in jsdom — these tests exercise the
 * pure logic with stubs, per the port's test boundary.
 */

import { describe, expect, it, vi } from "vitest";

import {
  drawLabels,
  labelAlphaForZoom,
  labelCapForZoom,
  truncateLabel,
  type LabelFrame,
} from "../src/ui/views/graph/renderer/labelCanvas.js";
import {
  GraphWebGLRenderer,
  planEdgeRender,
  type RendererEdge,
} from "../src/ui/views/graph/renderer/webglRenderer.js";

describe("label overlay contract", () => {
  it("caps labels by zoom (40 / 100 / 200 / 500)", () => {
    expect(labelCapForZoom(0.1)).toBe(40);
    expect(labelCapForZoom(0.29)).toBe(40);
    expect(labelCapForZoom(0.3)).toBe(100);
    expect(labelCapForZoom(0.59)).toBe(100);
    expect(labelCapForZoom(0.6)).toBe(200);
    expect(labelCapForZoom(0.99)).toBe(200);
    expect(labelCapForZoom(1.0)).toBe(500);
    expect(labelCapForZoom(3.0)).toBe(500);
  });

  it("truncates labels over 28 chars with an ellipsis", () => {
    expect(truncateLabel("short")).toBe("short");
    expect(truncateLabel("a".repeat(28))).toBe("a".repeat(28));
    expect(truncateLabel("a".repeat(29))).toBe(`${"a".repeat(27)}…`);
    expect(truncateLabel("a".repeat(60)).length).toBe(28);
  });

  it("fades labels in below zoom 0.12", () => {
    expect(labelAlphaForZoom(0.1)).toBeLessThanOrEqual(0);
    expect(labelAlphaForZoom(0.47)).toBeCloseTo(1, 5);
    expect(labelAlphaForZoom(2)).toBe(1);
  });

  function stubFrame(overrides: Partial<LabelFrame> = {}): {
    frame: LabelFrame;
    calls: Array<{ text: string; fillStyle: string }>;
  } {
    const calls: Array<{ text: string; fillStyle: string }> = [];
    const ctx = {
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      fillText: vi.fn((text: string) => {
        calls.push({ text, fillStyle: (ctx as unknown as { fillStyle: string }).fillStyle });
      }),
    } as unknown as CanvasRenderingContext2D;
    const ids = Array.from({ length: 300 }, (_, i) => `n${i}`);
    const names = new Map(ids.map((id) => [id, `Node ${id}`]));
    const positions = new Float32Array(ids.length * 2);
    const frame: LabelFrame = {
      ctx,
      width: 800,
      height: 600,
      dpr: 1,
      zoom: 0.5, // cap 100
      positions,
      order: ids,
      names,
      radii: new Map(),
      worldToScreen: (wx, wy) => ({ x: wx, y: wy }),
      baseNodeRadius: 8,
      hovered: null,
      selected: null,
      colors: { regular: "regular", emphasis: "emphasis", shadow: "shadow" },
      ...overrides,
    };
    return { frame, calls };
  }

  it("renders at most the cap and skips hovered/selected from the regular pass", () => {
    const { frame, calls } = stubFrame({ hovered: "n1", selected: "n2" });
    const rendered = drawLabels(frame);
    expect(rendered).toBe(100);
    expect(calls.length).toBe(102); // 100 regular + hovered + selected emphasis
    const regular = calls.filter((c) => c.fillStyle === "regular");
    expect(regular.some((c) => c.text === "Node n1")).toBe(false);
    expect(regular.some((c) => c.text === "Node n2")).toBe(false);
    const emphasis = calls.filter((c) => c.fillStyle === "emphasis");
    expect(emphasis.length).toBe(2);
    expect(emphasis.map((c) => c.text).join(" ")).toContain("Node n1");
    expect(emphasis.map((c) => c.text).join(" ")).toContain("Node n2");
  });

  it("culls labels far outside the viewport", () => {
    const far = stubFrame({
      worldToScreen: () => ({ x: -5000, y: -5000 }),
    });
    expect(drawLabels(far.frame)).toBe(0);
    expect(far.calls.length).toBe(0);
  });
});

describe("edge/arrow render planning", () => {
  const index = new Map([
    ["a", 0],
    ["b", 1],
    ["c", 2],
  ]);
  const edge = (source: string, target: string, linkType: number): RendererEdge => ({
    source,
    target,
    linkType,
  });

  it("a bidirectional relation keeps one quad and heads both ends", () => {
    const plan = planEdgeRender(
      [edge("a", "b", 2), edge("b", "a", 2)], // a↔b mentions
      index,
    );
    expect(plan.keep).toEqual([0]);
    // One head at b (a→b) and one at a (b→a), over the shared quad.
    expect(plan.arrows).toEqual([
      { edge: 0, i1: 0, i2: 1 },
      { edge: 0, i1: 1, i2: 0 },
    ]);
  });

  it("a one-direction relation keeps one quad with a single head at its target", () => {
    const plan = planEdgeRender([edge("a", "c", 0)], index); // a→c parent
    expect(plan.keep).toEqual([0]);
    expect(plan.arrows).toEqual([{ edge: 0, i1: 0, i2: 2 }]);
  });

  it("same pair with different link types stays two relations", () => {
    const plan = planEdgeRender([edge("a", "b", 2), edge("b", "a", 0)], index);
    expect(plan.keep).toEqual([0, 1]);
    expect(plan.arrows).toEqual([
      { edge: 0, i1: 0, i2: 1 },
      { edge: 1, i1: 1, i2: 0 },
    ]);
  });

  it("property and semantic families carry no arrowheads", () => {
    const plan = planEdgeRender(
      [edge("a", "b", 3), edge("b", "a", 3), edge("a", "b", 4)],
      index,
    );
    expect(plan.keep).toEqual([0, 2]); // reciprocal property pair shares one quad
    expect(plan.arrows).toEqual([]);
  });

  it("edges referencing unknown nodes are dropped", () => {
    const plan = planEdgeRender([edge("a", "ghost", 2)], index);
    expect(plan.keep).toEqual([]);
    expect(plan.arrows).toEqual([]);
  });
});

describe("webgl renderer", () => {
  it("throws the honest error when WebGL2 is unavailable", () => {
    const canvas = {
      getContext: () => null,
    } as unknown as HTMLCanvasElement;
    const renderer = new GraphWebGLRenderer();
    expect(() => renderer.init(canvas)).toThrow("WebGL2 not supported");
  });

  it("fitToCanvas and camera math work without a GL context", () => {
    const renderer = new GraphWebGLRenderer();
    // Camera state is plain math — no GL needed.
    renderer.setCamera(10, 20, 1.5);
    const screen = renderer.worldToScreen(0, 0);
    expect(Number.isFinite(screen.x)).toBe(true);
    expect(Number.isFinite(screen.y)).toBe(true);
    const world = renderer.screenToWorld(screen.x, screen.y);
    expect(world.x).toBeCloseTo(0, 4);
    expect(world.y).toBeCloseTo(0, 4);
  });
});
