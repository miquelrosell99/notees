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

  it("renders at most the cap and skips selected from the regular pass", () => {
    // No node hover: the regular pass runs (the hover-only contract has its
    // own spec below) and the selected node rides the emphasis pass.
    const { frame, calls } = stubFrame({ selected: "n2" });
    const rendered = drawLabels(frame);
    expect(rendered).toBe(100);
    expect(calls.length).toBe(101); // 100 regular + selected emphasis
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
    expect(drawLabels(frame)).toBe(100); // the cap still binds
    const regular = calls.filter((c) => c.fillStyle === "regular");
    expect(regular.length).toBe(100);
    expect(regular.every((c) => c.alpha === 0.25)).toBe(true); // zoom 0.5 → labelAlpha 1 × 0.25
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

describe("webgl renderer: time-lapse + hover-neighborhood contract", () => {
  // A recording WebGL2 stand-in (real GL contexts don't exist in jsdom).
  // getUniformLocation returns the NAME so uniform assertions read directly;
  // bufferSubData recordings carry the bound buffer for per-buffer assertions.
  function stubGl() {
    const bufferSubDataCalls: Array<{ buf: unknown; data: ArrayBufferView }> = [];
    const uniform1iCalls: Array<{ name: unknown; value: number }> = [];
    const uniform1fCalls: Array<{ name: unknown; value: number }> = [];
    const uniform3fCalls: Array<{ name: unknown; value: [number, number, number] }> = [];
    let bound: unknown = null;
    const gl = {
      VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30,
      COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
      ARRAY_BUFFER: 0x8892, STATIC_DRAW: 0x88e4, DYNAMIC_DRAW: 0x88e8,
      TRIANGLES: 0x0004, BLEND: 0x0be2,
      SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303, ONE: 1,
      TEXTURE_2D: 0x0de1, TEXTURE0: 0x84c0,
      TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
      TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
      NEAREST: 0x2600, CLAMP_TO_EDGE: 0x812f,
      RG32F: 0x822b, RG: 0x8227, FLOAT: 0x1406, UNSIGNED_BYTE: 0x1401,
      COLOR_BUFFER_BIT: 0x4000,
      createShader: () => ({}), shaderSource: vi.fn(), compileShader: vi.fn(),
      getShaderParameter: () => true, getShaderInfoLog: () => "",
      createProgram: () => ({}), attachShader: vi.fn(), linkProgram: vi.fn(),
      getProgramParameter: () => true, getProgramInfoLog: () => "",
      deleteShader: vi.fn(), deleteProgram: vi.fn(), deleteBuffer: vi.fn(),
      deleteVertexArray: vi.fn(), deleteTexture: vi.fn(),
      enable: vi.fn(), blendFuncSeparate: vi.fn(), clearColor: vi.fn(),
      clear: vi.fn(), viewport: vi.fn(), useProgram: vi.fn(),
      createVertexArray: () => ({}), bindVertexArray: vi.fn(),
      createBuffer: () => ({}),
      bindBuffer: vi.fn((_t: unknown, buf: unknown) => { bound = buf; }),
      bufferData: vi.fn(),
      bufferSubData: vi.fn((_t: unknown, _off: unknown, data: ArrayBufferView) => {
        bufferSubDataCalls.push({ buf: bound, data });
      }),
      getAttribLocation: () => 0,
      enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(),
      vertexAttribDivisor: vi.fn(),
      createTexture: () => ({}), bindTexture: vi.fn(), texParameteri: vi.fn(),
      texImage2D: vi.fn(), texSubImage2D: vi.fn(),
      getUniformLocation: (_p: unknown, name: string) => name,
      uniform2fv: vi.fn(),
      uniform3f: vi.fn((loc: unknown, x: number, y: number, z: number) => {
        uniform3fCalls.push({ name: loc, value: [x, y, z] });
      }),
      uniform1f: vi.fn((loc: unknown, value: number) => {
        uniform1fCalls.push({ name: loc, value });
      }),
      uniform1i: vi.fn((loc: unknown, value: number) => {
        uniform1iCalls.push({ name: loc, value });
      }),
      activeTexture: vi.fn(),
      drawArraysInstanced: vi.fn(),
    } as unknown as WebGL2RenderingContext;
    const canvas = {
      width: 800, height: 600,
      getContext: () => gl,
    } as unknown as HTMLCanvasElement;
    return { gl, canvas, bufferSubDataCalls, uniform1iCalls, uniform1fCalls, uniform3fCalls };
  }

  const IDS = ["a", "b", "c"];

  function liveRenderer() {
    const harness = stubGl();
    const renderer = new GraphWebGLRenderer();
    renderer.init(harness.canvas);
    renderer.setNodeVisuals(IDS, new Map());
    renderer.updatePositions(new Float32Array([0, 0, 10, 0, 20, 0]), IDS);
    // Identify the three highlight flag buffers by their Uint8Array uploads.
    const hlBuffers = () =>
      harness.bufferSubDataCalls.filter((c) => c.data instanceof Uint8Array);
    return { ...harness, renderer, hlBuffers };
  }

  it("setNodeTimes writes seconds-since-epoch into the per-node a_time slot", () => {
    const { renderer, bufferSubDataCalls } = liveRenderer();
    // Small magnitudes so both values stay exactly representable in float32.
    const t0 = 1_000_000;
    renderer.setNodeTimes(new Float32Array([t0, t0 + 60, -Infinity]));
    renderer.render();
    const nodeUpload = bufferSubDataCalls.find(
      (c) => c.data instanceof Float32Array && c.data[7] === t0,
    );
    expect(nodeUpload).toBeDefined();
    const data = nodeUpload!.data as Float32Array;
    // NODE_STRIDE layout: a_time rides at offset 7.
    expect(data[7]).toBe(t0);
    expect(data[15]).toBe(t0 + 60);
    expect(data[23]).toBe(-Infinity); // the no-time marker
  });

  it("setTimeLapse drives u_timeLapse/u_timeCutoff; disabled is the neutral path", () => {
    const { renderer, uniform1iCalls, uniform1fCalls } = liveRenderer();
    const timeLapse = () =>
      uniform1iCalls.filter((c) => c.name === "u_timeLapse").at(-1)?.value;
    renderer.render();
    expect(timeLapse()).toBe(0);
    renderer.setTimeLapse(true, 1_700_000_000);
    renderer.render();
    expect(timeLapse()).toBe(1);
    expect(uniform1fCalls.filter((c) => c.name === "u_timeCutoff").at(-1)?.value).toBe(1_700_000_000);
    renderer.setTimeLapse(false, 0);
    renderer.render();
    expect(timeLapse()).toBe(0);
  });

  it("RendererEdge.createdAt lands in the edge instance's a_time slot", () => {
    const { renderer, bufferSubDataCalls } = liveRenderer();
    const t = 1_700_000_000;
    renderer.setEdges([
      { source: "a", target: "b", linkType: 0, createdAt: t },
      { source: "b", target: "c", linkType: 2 },
    ]);
    renderer.render();
    const edgeUpload = bufferSubDataCalls.find(
      (c) => c.data instanceof Float32Array && c.data[15] === t,
    )!;
    const data = edgeUpload.data as Float32Array;
    // EDGE_STRIDE layout: a_time rides at offset 15 per instance.
    expect(data[15]).toBe(t);
    expect(data[31]).toBe(-Infinity); // un-stamped edge
  });

  it("setHoverNeighborhood flags the focus node (2), its neighbors (1), and incident edges (1); the accent rides the uniforms", () => {
    const { renderer, hlBuffers, uniform1fCalls, uniform3fCalls } = liveRenderer();
    renderer.setEdges([
      { source: "a", target: "b", linkType: 0 },
      { source: "b", target: "c", linkType: 2 },
    ]);
    const hoverDim = () => uniform1fCalls.filter((c) => c.name === "u_hoverDim").at(-1)?.value;
    const hoverMix = () => uniform1fCalls.filter((c) => c.name === "u_hoverMix").at(-1)?.value;
    const hoverColor = () => uniform3fCalls.filter((c) => c.name === "u_hoverColor").at(-1)?.value;
    // No neighborhood yet: the dim + highlight uniforms stay neutral.
    renderer.setHoverNeighborhood(null);
    renderer.render();
    expect(hoverDim()).toBe(1.0);
    expect(hoverMix()).toBe(0.0);

    const ACCENT: readonly [number, number, number] = [0.1, 0.2, 0.3];
    renderer.setHoverNeighborhood("b", ACCENT);
    renderer.render();
    // One Uint8 batch per flag buffer (node, edge, arrow) per hover change.
    const batch = hlBuffers().slice(-3);
    expect(batch.length).toBe(3);
    // Node flags are THREE-level: 0 outside · 1 direct neighbor · 2 hovered.
    const nodeFlags = batch[0]!.data as Uint8Array;
    expect([...nodeFlags.slice(0, 3)]).toEqual([1, 2, 1]); // b hovered, a + c neighbors
    const edgeFlags = batch[1]!.data as Uint8Array;
    expect([...edgeFlags.slice(0, 2)]).toEqual([1, 1]); // both edges incident to b
    // Dim-not-hide (0.2) and the ACCENT rgb highlight at full mix.
    expect(hoverDim()).toBeCloseTo(0.2, 5);
    expect(hoverMix()).toBe(1.0);
    expect(hoverColor()).toEqual([0.1, 0.2, 0.3]);

    // Repeating the same id is a no-op (no extra flag rewrites).
    const countAfterFirst = hlBuffers().length;
    renderer.setHoverNeighborhood("b", ACCENT);
    renderer.render();
    expect(hlBuffers().length).toBe(countAfterFirst);

    // Clearing restores the neutral dim and full-bright flags.
    renderer.setHoverNeighborhood(null);
    renderer.render();
    expect(hoverDim()).toBe(1.0);
    expect(hoverMix()).toBe(0.0);
    expect([...(hlBuffers().at(-3)!.data as Uint8Array).slice(0, 3)]).toEqual([0, 0, 0]);
  });

  it("an unknown hover id dims everything (no node matches the neighborhood)", () => {
    const { renderer, hlBuffers } = liveRenderer();
    renderer.setEdges([{ source: "a", target: "b", linkType: 0 }]);
    renderer.setHoverNeighborhood("ghost");
    renderer.render();
    const batch = hlBuffers().slice(-3);
    const nodeFlags = batch[0]!.data as Uint8Array;
    expect([...nodeFlags.slice(0, 3)]).toEqual([0, 0, 0]);
    const edgeFlags = batch[1]!.data as Uint8Array;
    expect([...edgeFlags.slice(0, 1)]).toEqual([0]);
  });

  it("nodeIndexLookup exposes the id → index mapping for the caller's time arrays", () => {
    const { renderer } = liveRenderer();
    expect(renderer.nodeIndexLookup.get("a")).toBe(0);
    expect(renderer.nodeIndexLookup.get("c")).toBe(2);
    expect(renderer.nodeIndexLookup.get("ghost")).toBeUndefined();
    expect(renderer.nodeIndexLookup.size).toBe(3);
  });
});
