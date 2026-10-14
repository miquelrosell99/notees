/**
 * graph/renderer tests: the label overlay contract (zoom caps,
 * truncation, culling, emphasis), the edge/arrow render planning, and the
 * adapter's camera math. Real GPU contexts don't exist in jsdom — these
 * tests exercise the pure logic, per the port's test boundary.
 */

import { describe, expect, it, vi } from "vitest";

import {
  drawLabels,
  labelAlphaForZoom,
  labelCapForZoom,
  labelSignatureChanged,
  truncateLabel,
  type LabelDrawSignature,
  type LabelFrame,
} from "../src/ui/views/graph/renderer/labelCanvas.js";
import { planEdgeRender, type RendererEdge } from "../src/ui/views/graph/renderer/edgePlan.js";
import { GraphPixiRenderer } from "../src/ui/views/graph/renderer/pixiRenderer.js";
import { lodLevelForZoom } from "../src/ui/views/graph/renderer/graphRenderer.js";

describe("GraphRenderer adapter contract", () => {
  it("lodLevelForZoom drives the adapter's level-of-detail (contract hook)", () => {
    expect(lodLevelForZoom(0.05)).toBe(0);
    expect(lodLevelForZoom(0.24)).toBe(0);
    expect(lodLevelForZoom(0.25)).toBe(1);
    expect(lodLevelForZoom(0.99)).toBe(1);
    expect(lodLevelForZoom(1.0)).toBe(2);
    expect(lodLevelForZoom(4.0)).toBe(2);
  });
});

describe("label overlay contract", () => {
  it("caps labels by zoom (60 / 200 / 500 — the closer-zoom ruling)", () => {
    expect(labelCapForZoom(0.1)).toBe(60);
    expect(labelCapForZoom(0.49)).toBe(60);
    expect(labelCapForZoom(0.5)).toBe(200);
    expect(labelCapForZoom(0.79)).toBe(200);
    expect(labelCapForZoom(0.8)).toBe(500);
    expect(labelCapForZoom(1.0)).toBe(500);
    expect(labelCapForZoom(3.0)).toBe(500);
  });

  it("truncates labels over 28 chars with an ellipsis", () => {
    expect(truncateLabel("short")).toBe("short");
    expect(truncateLabel("a".repeat(28))).toBe("a".repeat(28));
    expect(truncateLabel("a".repeat(29))).toBe(`${"a".repeat(27)}…`);
    expect(truncateLabel("a".repeat(60)).length).toBe(28);
  });

  it("fades labels in between zoom 0.3 and 0.7 (the closer-zoom ruling)", () => {
    expect(labelAlphaForZoom(0.2)).toBeLessThanOrEqual(0);
    expect(labelAlphaForZoom(0.5)).toBeCloseTo(0.5, 5);
    expect(labelAlphaForZoom(0.7)).toBeCloseTo(1, 5);
    expect(labelAlphaForZoom(2)).toBe(1);
  });

  function stubFrame(overrides: Partial<LabelFrame> = {}): {
    frame: LabelFrame;
    calls: Array<{ text: string; fillStyle: string; alpha: number; y: number }>;
  } {
    const calls: Array<{ text: string; fillStyle: string; alpha: number; y: number }> = [];
    const ctx = {
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      fillText: vi.fn((text: string, _x: number, y: number) => {
        const c = ctx as unknown as { fillStyle: string; globalAlpha: number };
        calls.push({ text, fillStyle: c.fillStyle, alpha: c.globalAlpha, y });
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
      zoom: 0.5, // cap 200
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

  it("renders at most the cap and skips selected from the regular pass", () => {
    // No node hover: the regular pass runs (the hover-only contract has its
    // own spec below) and the selected node rides the emphasis pass.
    const { frame, calls } = stubFrame({ selected: "n2" });
    const rendered = drawLabels(frame);
    expect(rendered).toBe(200);
    expect(calls.length).toBe(201); // 200 regular + selected emphasis
    const regular = calls.filter((c) => c.fillStyle === "regular");
    expect(regular.some((c) => c.text === "Node n2")).toBe(false);
    const emphasis = calls.filter((c) => c.fillStyle === "emphasis");
    expect(emphasis.length).toBe(1);
    expect(emphasis[0]!.text).toBe("Node n2");
  });

  it("while a node hover is active labels DIM to a quarter but never hide; the hovered label renders at full alpha with the nudge", () => {
    // Owner ruling (2026-10-13, Obsidian reference): the regular pass still
    // runs (cap respected) at labelAlpha × 0.25; the hovered label rides the
    // emphasis pass at full alpha, 3·dpr px below its normal offset; the
    // selected emphasis label is untouched (full alpha).
    const { frame, calls } = stubFrame({ hovered: "n1", selected: "n2" });
    expect(drawLabels(frame)).toBe(200); // the cap still binds
    const regular = calls.filter((c) => c.fillStyle === "regular");
    expect(regular.length).toBe(200);
    // zoom 0.5 → baseAlpha (0.5−0.3)/0.4 = 0.5, dimmed to a quarter on hover.
    expect(regular.every((c) => c.alpha === 0.125)).toBe(true);
    expect(regular.some((c) => c.text === "Node n1")).toBe(false); // hovered skips the regular pass
    const emphasis = calls.filter((c) => c.fillStyle === "emphasis");
    expect(emphasis.length).toBe(2);
    const hovered = emphasis.find((c) => c.text === "Node n1")!;
    const selected = emphasis.find((c) => c.text === "Node n2")!;
    expect(hovered.alpha).toBe(1);
    expect(selected.alpha).toBe(1);
    // Normal offset: radius 8 × zoom 0.5 + 4 = 8 px (dpr 1); the hovered
    // label nudges +3·dpr below it.
    expect(hovered.y).toBe(11);
    expect(selected.y).toBe(8);
  });

  it("the hovered label renders even below the zoom threshold", () => {
    const { frame, calls } = stubFrame({ hovered: "n1", zoom: 0.05 });
    expect(drawLabels(frame)).toBe(0); // the regular pass still honors the threshold
    expect(calls.map((c) => c.text)).toEqual(["Node n1"]);
    expect(calls[0]!.alpha).toBe(1);
  });

  it("small graphs (≤150 nodes) label at any zoom; large graphs keep the threshold", () => {
    // The camera fit can park a fitted small graph below the large-graph
    // 0.12 threshold — its labels must still render (capped, min alpha 0.3).
    const small = stubFrame({ zoom: 0.05 });
    small.frame.order = small.frame.order.slice(0, 50);
    small.frame.names = new Map(small.frame.names);
    const rendered = drawLabels(small.frame);
    expect(rendered).toBe(50); // every node fits under the zoom-0.05 cap (60)
    expect(small.calls.every((c) => c.alpha === 0.3)).toBe(true);
    // A large graph at the same zoom labels nothing (no hover).
    const large = stubFrame({ zoom: 0.05 });
    expect(drawLabels(large.frame)).toBe(0);
    expect(large.calls.length).toBe(0);
  });

  it("over the cap the labels go to the largest visible nodes (viewport-first, radius priority)", () => {
    // 300 nodes on a horizontal line 10 units apart — ~91 inside the viewport
    // + margin, over the zoom-0.4 cap of 60. n7 is the lone hub (radius
    // 1000) and must keep its label even though array-order capping would
    // drop it.
    const positions = new Float32Array(300 * 2);
    for (let i = 0; i < 300; i++) positions[i * 2] = i * 10;
    const { frame, calls } = stubFrame({ positions, radii: new Map([["n7", 1000]]), zoom: 0.4 });
    expect(drawLabels(frame)).toBe(60);
    expect(calls.some((c) => c.text === "Node n7")).toBe(true);
  });

  it("culls labels far outside the viewport", () => {
    const far = stubFrame({
      worldToScreen: () => ({ x: -5000, y: -5000 }),
    });
    expect(drawLabels(far.frame)).toBe(0);
    expect(far.calls.length).toBe(0);
  });

  it("the time-lapse cutoff suppresses labels for nodes created after it", () => {
    // Two nodes: n0 created before the cutoff, n1 after. Only n0's label
    // may render — the label overlay follows the GL canvas's hide rule.
    const createdTimes = new Map([
      ["n0", 1_000],
      ["n1", 2_000],
    ]);
    const { frame, calls } = stubFrame({
      order: ["n0", "n1"],
      positions: new Float32Array([10, 10, 20, 20]),
      names: new Map([
        ["n0", "Older"],
        ["n1", "Newer"],
      ]),
      createdTimes,
      timeCutoffSec: 1_500,
      zoom: 1,
    });
    expect(drawLabels(frame)).toBe(1);
    expect(calls.map((c) => c.text)).toEqual(["Older"]);
    // Without the cutoff context every label renders (backward compatible).
    const open = stubFrame({
      order: ["n0", "n1"],
      positions: new Float32Array([10, 10, 20, 20]),
      names: new Map([
        ["n0", "Older"],
        ["n1", "Newer"],
      ]),
      createdTimes,
      zoom: 1,
    });
    expect(drawLabels(open.frame)).toBe(2);
  });
});

describe("label idle-skip signature (owner 2026-10-13 jank fix)", () => {
  const base: LabelDrawSignature = {
    camX: 0, camY: 0, zoom: 0.5,
    frame: null,
    hovered: null,
    selected: null,
    names: null,
    tlEnabled: false, tlCutoff: 0,
    width: 800, height: 600,
  };

  it("an unchanged signature does not redraw — two static frames in a row skip the pass", () => {
    expect(labelSignatureChanged(base, { ...base })).toBe(false);
  });

  it("every label input changing forces a redraw", () => {
    const changes: Array<Partial<LabelDrawSignature>> = [
      { camX: 1 },
      { camY: 1 },
      { zoom: 0.7 },
      { frame: { positions: [] } }, // a new position frame identity
      { hovered: "n1" },
      { selected: ["n1"] }, // a new selection array identity
      { names: new Map() }, // a rebuilt name map identity
      { tlEnabled: true },
      { tlCutoff: 12 },
      { width: 1024 },
      { height: 768 },
    ];
    for (const change of changes) {
      expect(labelSignatureChanged(base, { ...base, ...change })).toBe(true);
    }
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
describe("adapter camera math", () => {
  it("fitToCanvas and camera math work without a GPU context", () => {
    const renderer = new GraphPixiRenderer();
    renderer.resize(800, 600);
    // Camera state is plain math — no GPU needed.
    renderer.setCamera(10, 20, 1.5);
    const screen = renderer.worldToScreen(0, 0);
    expect(Number.isFinite(screen.x)).toBe(true);
    expect(Number.isFinite(screen.y)).toBe(true);
    const world = renderer.screenToWorld(screen.x, screen.y);
    expect(world.x).toBeCloseTo(0, 4);
    expect(world.y).toBeCloseTo(0, 4);
  });
});
