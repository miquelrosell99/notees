/**
 * edgePlan.ts — the graph renderer's shared edge/arrow planning, the
 * renderer-facing types, and the theme-reactive edge color (owner
 * 2026-10-14: extracted from the retired WebGL adapter when Pixi graduated
 * as the only graph renderer). Pure logic + CSS reads — no GPU code.
 * Consumers: the GraphRenderer contract (graphRenderer.ts), the Pixi
 * adapter (pixiRenderer.ts), and GraphView's topology pass.
 */

// ─── Types (the renderer contract's data shapes) ────────────────────────────

export interface NodeVisual {
  radius: number;
  /** Explicit RGBA color. When undefined, the renderer uses --md-sys-color-outline from CSS. */
  color?: Float32Array;
  /** When true, the node is rendered slightly brighter as a pinned indicator. */
  pin?: boolean;
}

export interface RendererOptions {
  /** Default node radius in world units. Default: 8 */
  defaultRadius?: number;
  /** Default edge half-width in world units. Default: 0.8 */
  edgeWidth?: number;
  /** Arrow size in world units. Default: 3.5 */
  arrowSize?: number;
  /** Minimum node radius on screen in pixels when zoomed out. Default: 3 */
  minNodeRadiusPx?: number;
  /** Cull nodes/edges outside this many world units beyond the viewport. 0 = no culling. */
  cullMargin?: number;
  /** Pre-allocate instance capacity (resize automatically if exceeded). Default: 512 */
  initialCapacity?: number;
}

export interface CameraState {
  /** World-space X at the centre of the canvas. */
  x: number;
  /** World-space Y at the centre of the canvas. */
  y: number;
  /** Pixels per world unit. */
  zoom: number;
}

export interface RendererEdge {
  source: string;
  target: string;
  dashed?: boolean;
  /** Per-link-type curvature factor (overrides default). */
  curvature?: number;
  /** Compact link type id for LOD masking. */
  linkType?: number;
  /** Source node color RGBA — overrides default. */
  colorSrc?: [number, number, number, number];
  /** Target node color RGBA — overrides default. */
  colorTgt?: [number, number, number, number];
  /** Legacy single color (used as both src/tgt when gradient not needed). */
  color?: [number, number, number, number];
  width?: number;
  /** First-appearance time, seconds since epoch (drives the time-lapse cutoff). */
  createdAt?: number;
}

/**
 * The per-topology edge/arrow render plan:
 *   • keep — edges[] indices that get an edge quad. Reciprocal pairs (same
 *     link type, both directions) share ONE quad — two identical edges drawn
 *     on top of each other read as one heavier line.
 *   • arrows — one entry per arrowhead: a one-direction relation gets a head
 *     at its target; a bidirectional relation gets a head at BOTH ends
 *     (i1/i2 swapped), one shared quad underneath.
 */
export interface EdgeRenderPlan {
  keep: number[];
  arrows: Array<{ edge: number; i1: number; i2: number }>;
}

/**
 * Pure edge/arrow planning (unit-tested without a GPU). nodeIndex maps
 * node id → the renderer's position index; edges referencing unknown nodes
 * are dropped. Property (3) and semantic (4) families carry no arrowheads —
 * the clutter cut the renderer has always made.
 */
export function planEdgeRender(
  edges: RendererEdge[],
  nodeIndex: Map<string, number>,
): EdgeRenderPlan {
  const directions = new Map<string, Set<string>>();
  const endpoints = new Map<string, { a: number; b: number; firstEdge: number }>();
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    const si = nodeIndex.get(e.source);
    const ti = nodeIndex.get(e.target);
    if (si === undefined || ti === undefined) continue;
    const a = Math.min(si, ti);
    const b = Math.max(si, ti);
    const key = `${e.linkType ?? 0}:${a}:${b}`;
    let dirs = directions.get(key);
    if (dirs === undefined) {
      dirs = new Set();
      directions.set(key, dirs);
      endpoints.set(key, { a, b, firstEdge: i });
    }
    dirs.add(si === a ? "ab" : "ba");
  }

  const keep: number[] = [];
  const arrows: Array<{ edge: number; i1: number; i2: number }> = [];
  for (const [key, dirs] of directions) {
    const { a, b, firstEdge } = endpoints.get(key)!;
    keep.push(firstEdge);
    if (edges[firstEdge]!.linkType === 3 || edges[firstEdge]!.linkType === 4) continue;
    // One head per direction that exists: a→b heads at b, b→a heads at a.
    if (dirs.has("ab")) arrows.push({ edge: firstEdge, i1: a, i2: b });
    if (dirs.has("ba")) arrows.push({ edge: firstEdge, i1: b, i2: a });
  }
  return { keep, arrows };
}

// ─── Theme-reactive edge color ──────────────────────────────────────────────

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

const cssCache: { edge: [number, number, number, number] | null } = { edge: null };

function invalidateCssCache(): void {
  cssCache.edge = null;
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

/** The default edge color — --graph-edge-color, theme-reactive. */
export function getCssEdgeColor(): [number, number, number, number] {
  ensureThemeObserver();
  if (!cssCache.edge) {
    const val = getComputedStyle(document.documentElement)
      .getPropertyValue("--graph-edge-color")
      .trim();
    if (val && val.startsWith("#")) {
      cssCache.edge = hexToTuple(val, 1.0);
    } else {
      cssCache.edge = [0.38, 0.38, 0.38, 0.6];
    }
  }
  return cssCache.edge;
}
