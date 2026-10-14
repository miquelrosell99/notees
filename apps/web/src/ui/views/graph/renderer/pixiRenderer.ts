/**
 * PixiJS v8 graph renderer — the experimental adapter behind GraphRenderer
 * (owner 2026-10-14: adapter-first Pixi migration, flagged via
 * graphPrefs.renderer, default stays WebGL until parity is proven).
 *
 * Visual semantics are ported from webglRenderer.ts. What is identical:
 *   • Camera math (world→screen, fit, pick) — same formulas.
 *   • Node color pipeline: per-node RGBA × pin-brighten × selection dim
 *     (alpha × 0.55) × hover-neighborhood color rules (owner 2026-10-14:
 *     pure color, never opacity — hovered = accent fill, neighbors
 *     unchanged, everything else 20% darker).
 *   • Edge pipeline: per-edge color/width, LOD mask by linkType, selection
 *     dim, edge-hover alpha (0.35), hover recolor, time-lapse discard,
 *     min screen width 1px, curvature + the class-link sine wiggle sampled
 *     from the same GLSL curve math.
 *   • Arrowheads: the shared planEdgeRender eligibility (linkType 3/4 carry
 *     no heads), same triangle geometry, same target-radius offset.
 *   • Selection rings: filled disc at 1.85× the effective node radius,
 *     node's own color at 0.8 alpha, drawn under the nodes, capped at 64.
 *
 * Documented simplifications (LOD-parity trade-offs, revisited after the
 * load test):
 *   • Edge color gradient (src→tgt in the GL shader) collapses to the
 *     source color for the whole stroke.
 *   • Edge width taper (1.4× → 0.6× along the edge) collapses to the
 *     average width.
 *   • Dashes: Pixi v8 Graphics has no line-dash, so RendererEdge.dashed
 *     renders as the same 2px-on/4px-off dot pattern the GL fragment shader
 *     draws — approximated with short line segments along the sampled
 *     curve. (No current producer sets dashed; the path is latent.)
 *   • The min-screen-radius node clamp is a sprite-scale sync on zoom
 *     change (O(N) on the zoom input, not per frame).
 *   • Edge/arrow geometry is CPU-rebuilt when positions change (the GL
 *     adapter samples positions from a texture per frame instead). Static
 *     graphs — the resting state — ride the GPU world transform for free;
 *     a settling graph rebuilds per frame. The 50k load test decides if
 *     edge batching needs the same texture trick.
 *   • u_communityDim is stored and accepted but inert, matching the GL
 *     adapter: the same-community flag is hard-wired to 1 in the data path.
 */

import { Application, Container, Graphics, Sprite, type Texture } from "pixi.js";

import { MIN_NODE_SCREEN_RADIUS_PX } from "./graphConstants.js";
import type { GraphRenderer } from "./graphRenderer.js";
import { lodLevelForZoom } from "./graphRenderer.js";
import {
  getCssEdgeColor,
  planEdgeRender,
  type CameraState,
  type NodeVisual,
  type RendererEdge,
  type RendererOptions,
} from "./webglRenderer.js";

/** Radius of the pre-rendered white-circle node texture, in pixels. */
const NODE_TEXTURE_RADIUS_PX = 64;
/** Selection-ring cap — the GL adapter's MAX_RINGS. */
const MAX_RINGS = 64;
/** Alpha multiplier for non-highlighted nodes/edges while something is selected. */
const DIM_ALPHA = 0.55;
/** Un-stamped creation time — never compares greater than a cutoff. */
const NO_TIME = -Infinity;
/** Dotted-edge period in screen pixels (2 on, 4 off — the GL fragment rule). */
const DASH_PERIOD_PX = 6;
const DASH_ON_PX = 2;
/** The arrowhead's local triangle (multiplied by the arrow size). */
const ARROW_VERTS: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0.55],
  [-0.3, -0.45],
  [0.3, -0.45],
];
/** Sampling resolution for curved/dashed edges (screen px per segment). */
const CURVE_SEGMENTS = 16;
const DASH_SEGMENTS_PER_PX = 0.5;

// ─── Pure helpers (unit-tested without a GPU) ───────────────────────────────

/**
 * The owner-ruling (2026-10-14) hover recolor, shared by nodes, edges, and
 * arrowheads: a pure COLOR operation. `flag` is the neighborhood level —
 * nodes are three-level (0 outside · 1 neighbor · 2 hovered, accent at ≥2),
 * edges/arrowheads are binary (0 non-incident · 1 incident, accent at ≥1).
 * Inactive (no neighborhood) returns the base untouched. Alpha is never
 * touched here.
 */
export function hoverTintRgb(
  base: readonly [number, number, number],
  flag: 0 | 1 | 2,
  hoverActive: boolean,
  accent: readonly [number, number, number],
  accentLevel: 1 | 2,
): [number, number, number] {
  if (!hoverActive) return [base[0], base[1], base[2]];
  if (flag >= accentLevel) return [accent[0], accent[1], accent[2]];
  if (flag === 0) return [base[0] * 0.8, base[1] * 0.8, base[2] * 0.8];
  return [base[0], base[1], base[2]];
}

/** The GL fragment's LOD mask test: the linkType's bit must be set. */
export function linkTypeVisible(linkType: number, mask: number): boolean {
  return (mask & (1 << linkType)) !== 0;
}

/** The GL vertex shader's min-screen-radius clamp, in world units. */
export function nodeEffectiveRadius(
  worldRadius: number,
  zoom: number,
  minNodeRadiusPx: number,
): number {
  return Math.max(worldRadius, minNodeRadiusPx / (2.0 * zoom));
}

/** The time-lapse discard: created strictly after the cutoff renders hidden. */
export function timeLapseVisible(
  createdSec: number,
  enabled: boolean,
  cutoffSec: number,
): boolean {
  return !(enabled && createdSec > cutoffSec);
}

/** Constellation LOD (level 0) skips edges unless a hover is active. */
export function shouldDrawEdgesAtLod(lod: number, hoverActive: boolean): boolean {
  return lod > 0 || hoverActive;
}

/**
 * Sample the GL edge-vertex curve: quadratic Bezier bend for most links,
 * the 8π sine wiggle for class links (linkType ≈ 1), both with the same
 * formulas as EDGE_VERT_SRC. Returns (segments+1) points.
 */
export function sampleEdgePoints(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  curvature: number,
  linkType: number,
  zoom: number,
  segments = CURVE_SEGMENTS,
): Float32Array {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const px = len > 0.001 ? -dy / len : 0.0;
  const py = len > 0.001 ? dx / len : 1.0;
  const pts = new Float32Array((segments + 1) * 2);
  for (let s = 0; s <= segments; s++) {
    const t = s / segments;
    const curveOffset =
      Math.abs(linkType - 1.0) < 0.5
        ? (3.0 / zoom) * Math.sin(25.13274 * t)
        : curvature * Math.sin(Math.PI * t) * len;
    pts[s * 2] = x1 + dx * t + px * curveOffset;
    pts[s * 2 + 1] = y1 + dy * t + py * curveOffset;
  }
  return pts;
}

// ─── CSS color helpers (theme-reactive, same pattern as the GL adapter) ─────

function hexToTuple(hex: string, alpha = 1): [number, number, number, number] {
  const c = hex.replace("#", "");
  let r = 0;
  let g = 0;
  let b = 0;
  if (c.length === 3) {
    r = parseInt(c[0]! + c[0]!, 16);
    g = parseInt(c[1]! + c[1]!, 16);
    b = parseInt(c[2]! + c[2]!, 16);
  } else if (c.length >= 6) {
    r = parseInt(c.slice(0, 2), 16);
    g = parseInt(c.slice(2, 4), 16);
    b = parseInt(c.slice(4, 6), 16);
  }
  return [r / 255, g / 255, b / 255, alpha];
}

const cssCache: { nodeDefault: [number, number, number, number] | null } = {
  nodeDefault: null,
};

function invalidateCssCache(): void {
  cssCache.nodeDefault = null;
}

let themeObserverReady = false;
function ensureThemeObserver(): void {
  if (themeObserverReady || typeof MutationObserver === "undefined") return;
  themeObserverReady = true;
  new MutationObserver(invalidateCssCache).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "class"],
  });
}

/** The default node color — --graph-node-default, same resolution order as GL. */
export function getCssNodeDefaultColorPixi(): [number, number, number, number] {
  if (!cssCache.nodeDefault) {
    const val = getComputedStyle(document.documentElement)
      .getPropertyValue("--graph-node-default")
      .trim();
    if (val && val.startsWith("#")) {
      cssCache.nodeDefault = hexToTuple(val);
    } else {
      const fallback = getComputedStyle(document.documentElement)
        .getPropertyValue("--color-on-surface-variant")
        .trim();
      cssCache.nodeDefault = fallback ? hexToTuple(fallback) : [0.72, 0.72, 0.72, 1.0];
    }
  }
  return cssCache.nodeDefault;
}

function rgbaToTint(rgb: readonly [number, number, number]): number {
  const r = Math.round(Math.min(1, Math.max(0, rgb[0])) * 255);
  const g = Math.round(Math.min(1, Math.max(0, rgb[1])) * 255);
  const b = Math.round(Math.min(1, Math.max(0, rgb[2])) * 255);
  return (r << 16) | (g << 8) | b;
}

// ─── The adapter ────────────────────────────────────────────────────────────

interface EdgeStyleGroup {
  color: number;
  alpha: number;
  width: number;
  dashed: boolean;
  polylines: Array<{ pts: Float32Array; screenLen: number }>;
}

export class GraphPixiRenderer implements GraphRenderer {
  private app: Application | null = null;
  private world: Container = new Container();
  private ringGraphics: Graphics = new Graphics();
  private edgeGraphics: Graphics = new Graphics();
  private arrowGraphics: Graphics = new Graphics();
  private nodeLayer: Container = new Container();
  private nodeTexture: Texture | null = null;
  private spriteByIndex: Sprite[] = [];
  private sprites = new Map<string, Sprite>();
  /** True once Application.init resolved and the node texture exists. */
  private ready = false;
  private destroyed = false;
  /** Async init failure — set on the rejection path (init itself preflights
   *  WebGL2 synchronously so the common failure throws in init()). */
  initError: string | null = null;

  // --- Camera / canvas ---
  private camera: CameraState = { x: 0, y: 0, zoom: 1 };
  private canvasW = 1;
  private canvasH = 1;
  private lastZoom = -1;

  // --- Node metadata ---
  private nodeIndex = new Map<string, number>();
  private nodeVisuals = new Map<string, NodeVisual>();
  private nodeIdOrder: string[] = [];
  private positions: Float32Array = new Float32Array(0);
  private nodeTimes: Float32Array = new Float32Array(0);

  // --- Edge topology ---
  private edges: RendererEdge[] = [];
  private edgePlan: { keep: number[]; arrows: Array<{ edge: number; i1: number; i2: number }> } =
    { keep: [], arrows: [] };
  private edgeDrawCount = 0;
  private arrowDrawCount = 0;

  // --- Adjacency / highlight ---
  private adjacency = new Map<string, Set<string>>();
  private incidentEdges = new Map<string, number[]>();
  private highlightedIds = new Set<string>();
  private selectedNodeIds = new Set<string>();

  // --- Interaction state ---
  private hoverNeighborhoodId: string | null = null;
  private hoverColorRgb: readonly [number, number, number] = [1, 1, 1];
  private hoveredEdgeIndex = -1;
  private hoverEdgeAlpha = 1.0;
  private edgeMask = 0xffffffff;
  /** Stored for contract parity; inert like the GL path (sameComm is always 1). */
  private communityDim = 1.0;

  // --- Time-lapse ---
  private timeLapse = false;
  private timeCutoff = 0;

  // --- Dirty gates ---
  private nodesDirty = false;
  private edgesDirty = false;

  private opts: Required<Omit<RendererOptions, "cullMargin" | "initialCapacity">>;

  constructor(opts: RendererOptions = {}) {
    this.opts = {
      defaultRadius: opts.defaultRadius ?? 8,
      edgeWidth: opts.edgeWidth ?? 0.8,
      arrowSize: opts.arrowSize ?? 2.2,
      minNodeRadiusPx: opts.minNodeRadiusPx ?? MIN_NODE_SCREEN_RADIUS_PX,
    };
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  init(canvas: HTMLCanvasElement): void {
    // Honest synchronous failure (same contract as the GL adapter): a
    // detached probe canvas, so Pixi still owns the real context's
    // attributes on the provided canvas.
    const probe = document.createElement("canvas");
    if (probe.getContext("webgl2") === null) {
      throw new Error("WebGL2 not supported");
    }
    this.canvasW = canvas.width;
    this.canvasH = canvas.height;

    const world = this.world;
    world.addChild(this.ringGraphics);
    world.addChild(this.edgeGraphics);
    world.addChild(this.arrowGraphics);
    world.addChild(this.nodeLayer);

    const app = new Application();
    this.app = app;
    app
      .init({
        canvas,
        preference: "webgl",
        autoStart: false,
        sharedTicker: false,
        antialias: true,
        backgroundAlpha: 0,
        resolution: 1,
        autoDensity: false,
      })
      .then(() => {
        if (this.destroyed) return;
        // One pre-rendered white circle — per-node color rides sprite.tint
        // (multiply semantics = the GL fragment's color math).
        const circle = new Graphics()
          .circle(0, 0, NODE_TEXTURE_RADIUS_PX)
          .fill(0xffffff);
        this.nodeTexture = app.renderer.extract.texture(circle);
        circle.destroy();
        app.stage.addChild(world);
        app.renderer.resize(this.canvasW, this.canvasH);
        this.ready = true;
      })
      .catch((err: unknown) => {
        this.initError = err instanceof Error ? err.message : String(err);
        console.error("GraphPixiRenderer init failed:", err);
      });
    ensureThemeObserver();
  }

  destroy(): void {
    this.destroyed = true;
    this.sprites.clear();
    this.spriteByIndex = [];
    this.nodeTexture?.destroy();
    this.nodeTexture = null;
    if (this.app !== null && this.ready) {
      try {
        this.app.destroy(true, { children: true });
      } catch {
        // A mid-init destroy — nothing to release yet.
      }
    }
    this.app = null;
    this.ready = false;
  }

  resize(w: number, h: number): void {
    this.canvasW = w;
    this.canvasH = h;
    // The GraphView ResizeObserver fires before Pixi's async init resolves.
    if (this.app?.renderer) this.app.renderer.resize(w, h);
  }

  // ─── Data ─────────────────────────────────────────────────────────────────

  setNodeVisuals(nodeIds: ArrayLike<string>, visuals: Map<string, NodeVisual>): void {
    this.nodeVisuals = visuals;
    const n = nodeIds.length;
    this.nodeIdOrder = new Array<string>(n);
    this.nodeIndex.clear();
    for (let i = 0; i < n; i++) {
      const id = nodeIds[i]!;
      this.nodeIdOrder[i] = id;
      this.nodeIndex.set(id, i);
    }
    this.nodesDirty = true;
    this.edgesDirty = true; // indices changed
  }

  updatePositions(positions: Float32Array, nodeIds: string[]): void {
    this.positions = positions;
    if (nodeIds.length !== this.nodeIdOrder.length) {
      this.nodeIndex.clear();
      this.nodeIdOrder = nodeIds.slice();
      for (let i = 0; i < nodeIds.length; i++) {
        this.nodeIndex.set(nodeIds[i]!, i);
      }
      this.edgesDirty = true;
    }
    this.nodesDirty = true;
    this.edgesDirty = true; // edge geometry rides the position frames
  }

  overridePosition(nodeUuid: string, x: number, y: number): void {
    const idx = this.nodeIndex.get(nodeUuid);
    if (idx === undefined) return;
    if (this.positions.length >= (idx + 1) * 2) {
      this.positions[idx * 2] = x;
      this.positions[idx * 2 + 1] = y;
      this.nodesDirty = true;
      this.edgesDirty = true;
    }
  }

  setEdges(edges: RendererEdge[]): void {
    this.edges = edges;
    this.rebuildAdjacency();
    this.recomputeHighlighted();
    this.edgesDirty = true;
  }

  setNodeTimes(secondsByIndex: Float32Array): void {
    this.nodeTimes = secondsByIndex;
    this.nodesDirty = true;
  }

  setTimeLapse(enabled: boolean, cutoffSec: number): void {
    this.timeLapse = enabled;
    this.timeCutoff = cutoffSec;
    this.nodesDirty = true;
    this.edgesDirty = true;
  }

  // ─── Interaction setters ──────────────────────────────────────────────────

  setHoverNeighborhood(
    nodeId: string | null,
    accent: readonly [number, number, number] = [0.72, 0.72, 0.72],
  ): void {
    if (nodeId === this.hoverNeighborhoodId) return;
    this.hoverNeighborhoodId = nodeId;
    this.hoverColorRgb = nodeId !== null ? [accent[0], accent[1], accent[2]] : this.hoverColorRgb;
    this.nodesDirty = true;
    this.edgesDirty = true;
  }

  setHoveredNode(_id: string): void {
    // Mirrors the GL adapter: dimming is selection-driven only; the hovered
    // node needs no ring of its own (owner ruling 2026-10-13) — the
    // neighborhood pass paints the identifier.
  }

  setHoveredEdge(index: number): void {
    if (this.hoveredEdgeIndex === index) return;
    this.hoveredEdgeIndex = index;
    this.hoverEdgeAlpha = index >= 0 ? 0.35 : 1.0;
    this.edgesDirty = true;
  }

  setSelectedNodes(ids: string[]): void {
    const next = new Set(ids);
    if (
      next.size === this.selectedNodeIds.size &&
      ids.every((id) => this.selectedNodeIds.has(id))
    ) {
      return;
    }
    this.selectedNodeIds = next;
    this.recomputeHighlighted();
    this.nodesDirty = true;
    this.edgesDirty = true;
  }

  setEdgeMask(mask: number): void {
    if (mask === this.edgeMask) return;
    this.edgeMask = mask;
    this.edgesDirty = true;
  }

  setCommunityDim(dim: number): void {
    this.communityDim = dim;
  }

  // ─── Camera ───────────────────────────────────────────────────────────────

  setCamera(x: number, y: number, zoom: number): void {
    this.camera = { x, y, zoom };
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    const { x: cx, y: cy, zoom } = this.camera;
    return {
      x: (wx - cx) * zoom + this.canvasW * 0.5,
      y: (wy - cy) * zoom + this.canvasH * 0.5,
    };
  }

  screenToWorld(px: number, py: number): { x: number; y: number } {
    const { x: cx, y: cy, zoom } = this.camera;
    return {
      x: (px - this.canvasW * 0.5) / zoom + cx,
      y: (py - this.canvasH * 0.5) / zoom + cy,
    };
  }

  fitToCanvas(paddingPx = 60): CameraState {
    const n = this.nodeIdOrder.length;
    if (n === 0) return { ...this.camera };

    const pos = this.positions;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pos[i * 2]!;
      const y = pos[i * 2 + 1]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    const maxRadius = this.opts.defaultRadius * 2;
    const worldW = maxX - minX + maxRadius * 2;
    const worldH = maxY - minY + maxRadius * 2;

    const availW = this.canvasW - paddingPx * 2;
    const availH = this.canvasH - paddingPx * 2;

    let zoom = 1;
    if (worldW > 0 && worldH > 0) {
      zoom = Math.min(availW / worldW, availH / worldH);
    }
    zoom = Math.max(0.02, Math.min(zoom, 40));

    this.camera = { x: cx, y: cy, zoom };
    return { ...this.camera };
  }

  pickNode(wx: number, wy: number, maxDist = 20): string | null {
    const pos = this.positions;
    let best = -1;
    let bestD2 = maxDist * maxDist;
    for (let i = 0; i < this.nodeIdOrder.length; i++) {
      const dx = pos[i * 2]! - wx;
      const dy = pos[i * 2 + 1]! - wy;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    return best >= 0 ? (this.nodeIdOrder[best] ?? null) : null;
  }

  pickEdge(wx: number, wy: number, maxDist = 10): number {
    const pos = this.positions;
    const threshold2 = maxDist * maxDist;
    let bestIdx = -1;
    let bestD2 = threshold2;
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i]!;
      const si = this.nodeIndex.get(e.source);
      const ti = this.nodeIndex.get(e.target);
      if (si === undefined || ti === undefined) continue;
      const x1 = pos[si * 2]!;
      const y1 = pos[si * 2 + 1]!;
      const x2 = pos[ti * 2]!;
      const y2 = pos[ti * 2 + 1]!;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? ((wx - x1) * dx + (wy - y1) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const cx = x1 + t * dx;
      const cy = y1 + t * dy;
      const d2 = (wx - cx) * (wx - cx) + (wy - cy) * (wy - cy);
      if (d2 < bestD2) {
        bestD2 = d2;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  // ─── Read-only accessors ──────────────────────────────────────────────────

  get nodePositions(): Float32Array {
    return this.positions;
  }
  get nodeOrder(): string[] {
    return this.nodeIdOrder;
  }
  get nodeIndexLookup(): ReadonlyMap<string, number> {
    return this.nodeIndex;
  }
  get stats() {
    return {
      nodeInstCount: this.spriteByIndex.length,
      edgeInstCount: this.edgeDrawCount,
      arrowInstCount: this.arrowDrawCount,
      nodeDataCapacity: this.nodeIdOrder.length,
      edgeDataCapacity: this.edgePlan.keep.length,
    };
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private rebuildAdjacency(): void {
    this.adjacency.clear();
    this.incidentEdges.clear();
    for (let i = 0; i < this.edges.length; i++) {
      const { source, target } = this.edges[i]!;
      if (!this.adjacency.has(source)) this.adjacency.set(source, new Set());
      if (!this.adjacency.has(target)) this.adjacency.set(target, new Set());
      this.adjacency.get(source)!.add(target);
      this.adjacency.get(target)!.add(source);
      let incident = this.incidentEdges.get(source);
      if (incident === undefined) {
        incident = [];
        this.incidentEdges.set(source, incident);
      }
      incident.push(i);
      let incidentT = this.incidentEdges.get(target);
      if (incidentT === undefined) {
        incidentT = [];
        this.incidentEdges.set(target, incidentT);
      }
      incidentT.push(i);
    }
  }

  private recomputeHighlighted(): void {
    this.highlightedIds.clear();
    const focusIds = [...this.selectedNodeIds];
    for (const id of focusIds) {
      this.highlightedIds.add(id);
      const neighbours = this.adjacency.get(id);
      if (neighbours) for (const nb of neighbours) this.highlightedIds.add(nb);
    }
  }

  private hoverActive(): boolean {
    return this.hoverNeighborhoodId !== null;
  }

  /**
   * Node sprite sync — the tint/alpha/scale/visibility pass. O(N) on
   * position frames, zoom changes, and hover/selection/time-lapse changes;
   * nothing runs on a plain pan.
   */
  private syncNodes(): void {
    if (this.nodeTexture === null) return;
    const n = this.nodeIdOrder.length;
    const { zoom } = this.camera;

    // Grow / shrink the sprite pool to the node count.
    while (this.spriteByIndex.length < n) {
      const sprite = new Sprite(this.nodeTexture);
      sprite.anchor.set(0.5);
      this.nodeLayer.addChild(sprite);
      this.spriteByIndex.push(sprite);
    }
    while (this.spriteByIndex.length > n) {
      const sprite = this.spriteByIndex.pop()!;
      this.nodeLayer.removeChild(sprite);
      sprite.destroy();
    }

    const defaultColor = getCssNodeDefaultColorPixi();
    const hasFocus = this.highlightedIds.size > 0;
    const hoverOn = this.hoverActive();
    const focusId = this.hoverNeighborhoodId;
    const focusNodes = focusId !== null ? this.adjacency.get(focusId) : undefined;
    const minWorldRadius = this.opts.minNodeRadiusPx / (2.0 * zoom);

    this.sprites.clear();
    for (let i = 0; i < n; i++) {
      const id = this.nodeIdOrder[i]!;
      const sprite = this.spriteByIndex[i]!;
      const vis = this.nodeVisuals.get(id);
      const radius = vis?.radius ?? this.opts.defaultRadius;
      const color = vis?.color;

      sprite.position.set(this.positions[i * 2]!, this.positions[i * 2 + 1]!);
      const effRadius = Math.max(radius, minWorldRadius);
      sprite.scale.set(effRadius / NODE_TEXTURE_RADIUS_PX);

      const pinBrighten = vis?.pin ? 1.2 : 1.0;
      const base: [number, number, number] = [
        Math.min(1, (color ? color[0]! : defaultColor[0]) * pinBrighten),
        Math.min(1, (color ? color[1]! : defaultColor[1]) * pinBrighten),
        Math.min(1, (color ? color[2]! : defaultColor[2]) * pinBrighten),
      ];
      const flag: 0 | 1 | 2 =
        focusId === null ? 0 : id === focusId ? 2 : focusNodes?.has(id) ? 1 : 0;
      const tinted = hoverTintRgb(base, flag, hoverOn, this.hoverColorRgb, 2);
      sprite.tint = rgbaToTint(tinted);

      const baseAlpha = color ? color[3]! : defaultColor[3];
      const dimmed = hasFocus && !this.highlightedIds.has(id);
      sprite.alpha = dimmed ? baseAlpha * DIM_ALPHA : baseAlpha;

      const created = this.nodeTimes[i] ?? NO_TIME;
      sprite.visible = timeLapseVisible(created, this.timeLapse, this.timeCutoff);

      this.sprites.set(id, sprite);
    }

    // Selection rings (under the nodes, the GL ring pass's disc-and-rim look).
    const rings = this.ringGraphics;
    rings.clear();
    let ringCount = 0;
    for (const id of this.selectedNodeIds) {
      if (ringCount >= MAX_RINGS) break;
      const idx = this.nodeIndex.get(id);
      if (idx === undefined) continue;
      const vis = this.nodeVisuals.get(id);
      const baseRadius = vis?.radius ?? this.opts.defaultRadius;
      const effBaseRadius = Math.max(baseRadius, minWorldRadius);
      const nodeCol: ArrayLike<number> = vis?.color ?? defaultColor;
      rings
        .circle(this.positions[idx * 2]!, this.positions[idx * 2 + 1]!, effBaseRadius * 1.85)
        .fill({ color: rgbaToTint([nodeCol[0]!, nodeCol[1]!, nodeCol[2]!]), alpha: 0.8 });
      ringCount++;
    }
  }

  /**
   * Edge + arrow rebuild. Grouped by stroke style (color/alpha/width/dash)
   * so each group costs one Graphics stroke; curved/dashed edges are sampled
   * from the GL curve math.
   */
  private rebuildEdges(): void {
    const { zoom } = this.camera;
    const lod = lodLevelForZoom(zoom);
    const hoverOn = this.hoverActive();
    const hoverForEdges = hoverOn || this.hoveredEdgeIndex >= 0;

    const edges = this.edgeGraphics;
    edges.clear();
    this.edgeDrawCount = 0;
    if (!shouldDrawEdgesAtLod(lod, hoverForEdges) || this.positions.length === 0) {
      this.rebuildArrows();
      return;
    }

    const plan = this.edgePlan;
    const pos = this.positions;
    const defaultColor = getCssEdgeColor();
    const hasFocus = this.highlightedIds.size > 0;
    const focusId = this.hoverNeighborhoodId;
    const focusEdgeSet = new Set<number>();
    if (focusId !== null) {
      const incident = this.incidentEdges.get(focusId);
      if (incident) for (const ei of incident) focusEdgeSet.add(ei);
    }

    // Minimum full stroke width in world units (the GL min-pixel-width rule).
    const minWorldWidth = 1.0 / zoom;
    const groups = new Map<string, EdgeStyleGroup>();

    for (let k = 0; k < plan.keep.length; k++) {
      const ei = plan.keep[k]!;
      const e = this.edges[ei]!;
      const linkType = e.linkType ?? 0;
      if (!linkTypeVisible(linkType, this.edgeMask)) continue;
      if (!timeLapseVisible(e.createdAt ?? NO_TIME, this.timeLapse, this.timeCutoff)) continue;
      const si = this.nodeIndex.get(e.source);
      const ti = this.nodeIndex.get(e.target);
      if (si === undefined || ti === undefined) continue;
      const x1 = pos[si * 2]!;
      const y1 = pos[si * 2 + 1]!;
      const x2 = pos[ti * 2]!;
      const y2 = pos[ti * 2 + 1]!;

      const srcColor = e.colorSrc ?? e.color ?? this.nodeVisuals.get(e.source)?.color ?? defaultColor;
      const srcRgb: readonly [number, number, number] = [srcColor[0], srcColor[1], srcColor[2]];
      const incident = focusEdgeSet.has(ei) ? 1 : 0;
      const tinted = hoverOn ? hoverTintRgb(srcRgb, incident as 0 | 1, true, this.hoverColorRgb, 1) : srcRgb;

      const edgeHighlighted =
        !hasFocus || this.highlightedIds.has(e.source) || this.highlightedIds.has(e.target);
      const dimMult = edgeHighlighted ? 1.0 : DIM_ALPHA;
      // Taper collapses to the average width (1.4×/0.6× average = 1.0×).
      const width = Math.max(e.width ?? this.opts.edgeWidth, minWorldWidth);
      const alpha = srcColor[3] * dimMult * this.hoverEdgeAlpha;

      const dashed = e.dashed === true;
      const len = Math.hypot(x2 - x1, y2 - y1);
      const screenLen = len * zoom;
      const curved = Math.abs(linkType - 1) < 0.5 || (e.curvature ?? 0) !== 0;

      let pts: Float32Array;
      let sampleScreenLen = screenLen;
      if (curved) {
        pts = sampleEdgePoints(x1, y1, x2, y2, e.curvature ?? 0, linkType, zoom);
        // The curve is longer than the chord — approximate by sampling.
        sampleScreenLen = 0;
        for (let s = 1; s <= CURVE_SEGMENTS; s++) {
          sampleScreenLen += Math.hypot(
            pts[s * 2]! - pts[(s - 1) * 2]!,
            pts[s * 2 + 1]! - pts[(s - 1) * 2 + 1]!,
          );
        }
        sampleScreenLen *= zoom;
      } else {
        pts = new Float32Array([x1, y1, x2, y2]);
      }

      // The GL dot rule: dashes only when the edge is longer than 1 screen px.
      const effectiveDashed = dashed && screenLen > 1.0;
      const key = `${rgbaToTint(tinted)}|${Math.round(alpha * 255)}|${Math.round(width * 100)}|${effectiveDashed ? 1 : 0}`;
      let group = groups.get(key);
      if (group === undefined) {
        group = {
          color: rgbaToTint(tinted),
          alpha,
          width,
          dashed: effectiveDashed,
          polylines: [],
        };
        groups.set(key, group);
      }
      group.polylines.push({ pts, screenLen: sampleScreenLen });
      this.edgeDrawCount++;
    }

    for (const group of groups.values()) {
      for (const poly of group.polylines) {
        if (!group.dashed) {
          edges.moveTo(poly.pts[0]!, poly.pts[1]!);
          for (let s = 1; s < poly.pts.length / 2; s++) {
            edges.lineTo(poly.pts[s * 2]!, poly.pts[s * 2 + 1]!);
          }
        } else {
          this.strokeDashed(edges, poly.pts, poly.screenLen);
        }
      }
      edges.stroke({ color: group.color, alpha: group.alpha, width: group.width });
    }

    this.rebuildArrows();
  }

  /** Dotted strokes: 2px on / 4px off along the curve in screen space. */
  private strokeDashed(g: Graphics, pts: Float32Array, screenLen: number): void {
    const { zoom } = this.camera;
    const segments = Math.min(128, Math.max(CURVE_SEGMENTS, Math.ceil(screenLen * DASH_SEGMENTS_PER_PX)));
    // Resample to ~2px screen steps so the dot pattern follows curves.
    let d = 0;
    for (let s = 1; s < pts.length / 2; s++) {
      d += Math.hypot(pts[s * 2]! - pts[(s - 1) * 2]!, pts[s * 2 + 1]! - pts[(s - 1) * 2 + 1]!);
    }
    let on = false;
    let prevX = pts[0]!;
    let prevY = pts[1]!;
    for (let i = 1; i <= segments; i++) {
      const targetD = (d * i) / segments;
      // Walk the polyline to the target arc length.
      let acc = 0;
      let wx = pts[pts.length - 2]!;
      let wy = pts[pts.length - 1]!;
      for (let s = 1; s < pts.length / 2; s++) {
        const segLen = Math.hypot(pts[s * 2]! - pts[(s - 1) * 2]!, pts[s * 2 + 1]! - pts[(s - 1) * 2 + 1]!);
        if (acc + segLen >= targetD) {
          const f = segLen > 0 ? (targetD - acc) / segLen : 0;
          wx = pts[(s - 1) * 2]! + (pts[s * 2]! - pts[(s - 1) * 2]!) * f;
          wy = pts[(s - 1) * 2 + 1]! + (pts[s * 2 + 1]! - pts[(s - 1) * 2 + 1]!) * f;
          break;
        }
        acc += segLen;
      }
      const posPx = targetD * zoom;
      const inOn = posPx % DASH_PERIOD_PX <= DASH_ON_PX;
      if (inOn && !on) {
        g.moveTo(prevX, prevY);
        on = true;
      }
      if (!inOn && on) {
        g.lineTo(prevX, prevY);
        on = false;
      }
      prevX = wx;
      prevY = wy;
    }
    if (on) g.lineTo(prevX, prevY);
  }

  /** Arrowheads — the shared render plan, the GL triangle geometry. */
  private rebuildArrows(): void {
    const g = this.arrowGraphics;
    g.clear();
    this.arrowDrawCount = 0;
    // Arrows ignore the LOD mask in the GL adapter — only constellation
    // hiding and time-lapse apply.
    const lod = lodLevelForZoom(this.camera.zoom);
    if (!shouldDrawEdgesAtLod(lod, this.hoverActive() || this.hoveredEdgeIndex >= 0)) return;
    if (this.positions.length === 0) return;

    const { zoom } = this.camera;
    const pos = this.positions;
    const defaultColor = getCssEdgeColor();
    const hasFocus = this.highlightedIds.size > 0;
    const hoverOn = this.hoverActive();
    const minWorldRadius = this.opts.minNodeRadiusPx / (2.0 * zoom);
    const focusEdgeSet = new Set<number>();
    if (this.hoverNeighborhoodId !== null) {
      const incident = this.incidentEdges.get(this.hoverNeighborhoodId);
      if (incident) for (const ei of incident) focusEdgeSet.add(ei);
    }

    for (const { edge, i1, i2 } of this.edgePlan.arrows) {
      const e = this.edges[edge]!;
      if (!timeLapseVisible(e.createdAt ?? NO_TIME, this.timeLapse, this.timeCutoff)) continue;
      const x1 = pos[i1 * 2]!;
      const y1 = pos[i1 * 2 + 1]!;
      const x2 = pos[i2 * 2]!;
      const y2 = pos[i2 * 2 + 1]!;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (len <= 0.001) continue;
      const nx = dx / len;
      const ny = dy / len;
      const px = -ny;
      const py = nx;

      const [er, eg, eb, ea] = e.color ?? defaultColor;
      const edgeHighlighted =
        !hasFocus || this.highlightedIds.has(e.source) || this.highlightedIds.has(e.target);
      const finalAlpha = edgeHighlighted ? ea : ea * DIM_ALPHA;
      const tinted = hoverOn
        ? hoverTintRgb([er, eg, eb], focusEdgeSet.has(edge) ? 1 : 0, true, this.hoverColorRgb, 1)
        : ([er, eg, eb] as [number, number, number]);

      const headNodeId = this.nodeIdOrder[i2]!;
      const targetRadius = this.nodeVisuals.get(headNodeId)?.radius ?? this.opts.defaultRadius;
      const effTargetRadius = Math.max(targetRadius, minWorldRadius);
      const size = this.opts.arrowSize;
      const offset = effTargetRadius + size * 0.15;
      const cx0 = x2 - nx * offset;
      const cy0 = y2 - ny * offset;

      const poly: number[] = [];
      for (const [lx, ly] of ARROW_VERTS) {
        const sx = lx * size;
        const sy = ly * size;
        poly.push(cx0 + sx * px + sy * nx, cy0 + sx * py + sy * ny);
      }
      g.poly(poly, true).fill({ color: rgbaToTint(tinted), alpha: finalAlpha });
      this.arrowDrawCount++;
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  render(): void {
    const app = this.app;
    if (!app || !this.ready || this.destroyed) return;

    const { zoom } = this.camera;
    // World container: GPU transform, no CPU projection per node. The
    // negative Y scale reproduces the GL NDC y-flip (screen y-down vs
    // world y-up).
    this.world.position.set(this.canvasW * 0.5, this.canvasH * 0.5);
    this.world.scale.set(zoom, -zoom);

    if (this.nodesDirty || zoom !== this.lastZoom) {
      this.nodesDirty = false;
      this.syncNodes();
    }
    if (this.edgesDirty || zoom !== this.lastZoom) {
      this.edgesDirty = false;
      this.edgePlan = planEdgeRender(this.edges, this.nodeIndex);
      this.rebuildEdges();
    }
    this.lastZoom = zoom;

    app.render();
  }
}
