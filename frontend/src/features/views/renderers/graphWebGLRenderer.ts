/**
 * SGE WebGL2 Renderer
 *
 * GPU-accelerated graph renderer for the SemanticGraphEngine layout system.
 *
 * Design goals
 * ─────────────
 * • WebGL2 instanced draw calls — one draw per node type, one draw per edge type.
 * • Zero per-frame JS allocations when node/edge counts are stable.
 * • Zoom + pan applied entirely on the GPU via a single uniform (camera + zoom).
 * • Nodes: SDF circles (quad + fragment discard).
 * • Edges: expanded quads aligned along the edge direction.
 * • Optional CPU-side culling: skip uploading offscreen instances.
 *
 * Coordinate system
 * ──────────────────
 * • World space: arbitrary float units (matching SGE physics output).
 * • Camera (cx, cy) is the world-space point at the centre of the canvas.
 * • zoom is in pixels-per-world-unit.
 * • Clip space: standard WebGL NDC (-1..1).
 */

import { MIN_NODE_SCREEN_RADIUS_PX } from '../utils/graphConstants';

// ─── GLSL Shaders ─────────────────────────────────────────────────────────────

const NODE_VERT_SRC = /* glsl */ `#version 300 es
precision highp float;

// Per-vertex (unit quad: local space -0.5..0.5)
in vec2 a_quad;

// Per-instance
in vec2  a_pos;    // world-space centre
in float a_radius; // world-space radius
in vec4  a_color;  // RGBA 0..1

// Camera
uniform vec2  u_resolution; // canvas size in pixels
uniform vec2  u_camera;     // world position of screen centre
uniform float u_zoom;       // pixels per world unit
uniform float u_minRadiusPx; // minimum screen-space radius in pixels

out vec2 v_uv;
out vec4 v_color;

void main() {
  v_uv    = a_quad * 2.0;  // -1..1 for SDF
  v_color = a_color;

  // Ensure node never shrinks below a readable dot when zoomed out
  float effRadius = max(a_radius, u_minRadiusPx / (2.0 * u_zoom));
  // world-space vertex position
  vec2 world  = a_pos + a_quad * effRadius * 2.0;
  // world → screen (pixels, origin centre)
  vec2 screen = (world - u_camera) * u_zoom;
  // screen → NDC
  vec2 clip   = screen / (u_resolution * 0.5);

  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}
`;

const NODE_FRAG_SRC = /* glsl */ `#version 300 es
precision mediump float;

in vec2 v_uv;   // -1..1 local coord
in vec4 v_color;

out vec4 outColor;

void main() {
  float d  = length(v_uv);

  // Resolution-aware SDF antialiasing:
  // fwidth(d) returns dFdx(d) + dFdy(d) — the screen-space rate of change
  // of the signed distance.  Using it as the smoothstep half-width makes the
  // AA transition exactly ~1 pixel wide on screen regardless of node size,
  // zoom level, or device pixel ratio.  Without this, zooming out widens the
  // transition band (soft/blurry nodes) and zooming in narrows it (jagged).
  float fw    = fwidth(d);
  float alpha = 1.0 - smoothstep(1.0 - fw, 1.0 + fw, d);

  // Gamma-correct SDF edges:
  // smoothstep() produces linear alpha, but the default framebuffer blends
  // in perceptual (sRGB-like) space.  Without correction the transition band
  // is wider than intended and edges look slightly soft, especially on dark
  // backgrounds.  Applying the inverse-gamma (~1/2.2) to the raw SDF alpha
  // sharpens the perceptual falloff back to the intended linear width.
  alpha = pow(alpha, 1.0 / 2.2);

  if (alpha <= 0.01) discard;
  outColor = vec4(v_color.rgb, v_color.a * alpha);
}
`;

/**
 * Edge vertex shader — reads endpoint positions from the RG32F position texture
 * rather than from per-instance vertex data.  This means:
 *   • Edge instance buffer is STATIC topology (sourceIdx, targetIdx, width, color).
 *   • Positions are uploaded once per frame as a texture on the main thread.
 *   • No per-frame edge CPU repack when nodes move — GPU does the lookup.
 *   • Camera pan/zoom never touches edge data at all.
 */
const EDGE_VERT_SRC = /* glsl */ `#version 300 es
precision highp float;

// Per-vertex local quad coords
in vec2  a_local;  // x = side (-0.5..0.5), y = t (0..1 along edge)

// Per-instance — STATIC topology, no positions baked in
in float a_i1;           // source node index → texelFetch into u_positions
in float a_i2;           // target node index → texelFetch into u_positions
in float a_width;        // world-space base half-width
in vec4  a_colorSrc;     // RGBA 0..1 at source
in vec4  a_colorTgt;     // RGBA 0..1 at target
in float a_curvature;    // quadratic Bezier bend factor
in float a_linkType;     // compact type id for LOD masking
in float a_sameComm;     // 1.0 = same community, 0.0 = different
in float a_dashed;       // 0 = solid, 1 = dashed

// Camera
uniform vec2  u_resolution;
uniform vec2  u_camera;
uniform float u_zoom;

// RG32F position texture: texel(i, 0).rg = (x, y) for node i
uniform highp sampler2D u_positions;

out vec4  v_colorSrc;
out vec4  v_colorTgt;
out float v_dashed;
out float v_t;           // parametric position along edge (0..1)
out float v_screenLen;   // edge length in screen pixels
out float v_linkType;
out float v_sameComm;
out float v_localX;

void main() {
  v_colorSrc = a_colorSrc;
  v_colorTgt = a_colorTgt;
  v_dashed   = a_dashed;
  v_t        = a_local.y;
  v_linkType = a_linkType;
  v_sameComm = a_sameComm;
  v_localX   = a_local.x;

  // Zero-copy GPU-side position read
  int si = int(a_i1);
  int ti = int(a_i2);
  vec2 p1 = texelFetch(u_positions, ivec2(si, 0), 0).rg;
  vec2 p2 = texelFetch(u_positions, ivec2(ti, 0), 0).rg;

  vec2 dir  = p2 - p1;
  float len = length(dir);
  vec2 perp = (len > 0.001)
    ? vec2(-dir.y, dir.x) / len
    : vec2(0.0, 1.0);

  v_screenLen = len * u_zoom;

  // Curvature: smooth arc for most links, wiggly sine for class links
  float curveOffset;
  if (abs(a_linkType - 1.0) < 0.5) {
    curveOffset = (3.0 / u_zoom) * sin(25.13274 * a_local.y);
  } else {
    curveOffset = a_curvature * sin(3.14159265 * a_local.y) * len;
  }
  vec2 center = mix(p1, p2, a_local.y) + perp * curveOffset;

  // Tapered width: wider at source (t=0), narrower at target (t=1)
  float srcW = a_width * 1.4;
  float tgtW = a_width * 0.6;
  float halfWidth = mix(srcW, tgtW, a_local.y) * 0.5;

  // Ensure edge is at least 1.0 screen-pixel wide to prevent
  // sub-pixel aliasing that makes lines appear dashed when zoomed out.
  float minWorldWidth = 1.0 / u_zoom;
  halfWidth = max(halfWidth, minWorldWidth);

  vec2 world = center + perp * a_local.x * halfWidth;

  vec2 screen = (world - u_camera) * u_zoom;
  vec2 clip   = screen / (u_resolution * 0.5);

  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}
`;

const EDGE_FRAG_SRC = /* glsl */ `#version 300 es
precision mediump float;

in vec4  v_colorSrc;
in vec4  v_colorTgt;
in float v_dashed;
in float v_t;
in float v_screenLen;
in float v_linkType;
in float v_sameComm;
in float v_localX;

uniform int   u_edgeMask;      // bitmask of visible link types
uniform float u_communityDim;  // alpha multiplier for cross-community edges
uniform float u_hoverEdgeAlpha; // 1.0 normally, lower when an edge is hovered

out vec4 outColor;

void main() {
  // LOD mask: discard if this link type is hidden at current zoom
  int typeBit = 1 << int(v_linkType + 0.5);
  if ((u_edgeMask & typeBit) == 0) discard;

  // Dotted edges: discard fragments that fall in the gaps.
  // Dot period = 6px (2px on, 4px off) in screen space — tight dots.
  if (v_dashed > 0.5 && v_screenLen > 1.0) {
    float pos    = v_t * v_screenLen;
    float period = 6.0;
    float onLen  = 2.0;
    if (mod(pos, period) > onLen) discard;
  }

  // Gradient color from source to target
  vec4 color = mix(v_colorSrc, v_colorTgt, v_t);

  // Community dimming
  float alpha = color.a * mix(u_communityDim, 1.0, v_sameComm);

  // Edge-hover dimming of non-hovered edges
  alpha *= u_hoverEdgeAlpha;

  outColor = vec4(color.rgb, alpha);
}
`;

/**
 * Ring shader — drawn on top of nodes for hover and selection highlights.
 * Shares the same vertex layout as NODE (7 floats / instance).
 * Renders a smooth annulus around the node.
 */
const RING_VERT_SRC = /* glsl */ `#version 300 es
precision highp float;

in vec2  a_quad;
in vec2  a_pos;
in float a_radius;
in vec4  a_color;

uniform vec2  u_resolution;
uniform vec2  u_camera;
uniform float u_zoom;

out vec2 v_uv;
out vec4 v_color;

void main() {
  v_uv    = a_quad * 2.0;
  v_color = a_color;
  vec2 world  = a_pos + a_quad * a_radius * 2.0;
  vec2 screen = (world - u_camera) * u_zoom;
  vec2 clip   = screen / (u_resolution * 0.5);
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}
`;

/**
 * Ring disc fragment — drawn BEFORE nodes so it appears underneath them.
 * Renders a soft filled disc slightly larger than the node, peeking out around
 * the node edge as an outer circle (bullet-style hover/select indicator).
 */
const RING_FRAG_SRC = /* glsl */ `#version 300 es
precision mediump float;

in vec2 v_uv;
in vec4 v_color;
out vec4 outColor;

void main() {
  float d  = length(v_uv);

  // fwidth gives the screen-space derivative of d so the outer boundary of
  // this disc is always ~1 pixel wide, independent of zoom or DPR.
  // Drawn beneath the node which covers d < ~0.85, only the outer rim of
  // this disc is visible — producing a clean selection/hover indicator ring.
  float fw       = fwidth(d);
  float rawAlpha = 1.0 - smoothstep(1.0 - fw, 1.0 + fw, d);

  // Gamma correction — same rationale as NODE_FRAG_SRC.
  float alpha = pow(rawAlpha, 1.0 / 2.2) * v_color.a;
  if (alpha <= 0.01) discard;
  outColor = vec4(v_color.rgb, alpha);
}
`;

/**
 * Arrowhead vertex shader — draws a small triangle at the target end of each edge.
 * Samples endpoint positions from the RG32F texture so no CPU repack is needed.
 */
const ARROW_VERT_SRC = /* glsl */ `#version 300 es
precision highp float;

in vec2 a_local;   // triangle vertex: (-0.5,-0.5) (0.5,-0.5) (0,0.5)

in float a_i1;     // source node index
in float a_i2;     // target node index
in float a_targetRadius; // world units, to stop before node center
in float a_size;   // world units
in vec4  a_color;

uniform vec2  u_resolution;
uniform vec2  u_camera;
uniform float u_zoom;
uniform float u_minRadiusPx;
uniform highp sampler2D u_positions;

out vec4 v_color;

void main() {
  int si = int(a_i1);
  int ti = int(a_i2);
  vec2 p1 = texelFetch(u_positions, ivec2(si, 0), 0).rg;
  vec2 p2 = texelFetch(u_positions, ivec2(ti, 0), 0).rg;

  vec2 dir = p2 - p1;
  float len = length(dir);
  vec2 n = (len > 0.001) ? dir / len : vec2(1.0, 0.0);
  vec2 perp = vec2(-n.y, n.x);

  // Rotate and scale local triangle to point along edge direction
  vec2 local = a_local * a_size;
  vec2 rotated = local.x * perp + local.y * n;

  // Offset to just outside the target node radius (accounting for min-size clamp)
  float effTargetRadius = max(a_targetRadius, u_minRadiusPx / (2.0 * u_zoom));
  float offset = effTargetRadius + a_size * 0.15;
  vec2 world = p2 - n * offset + rotated;

  vec2 screen = (world - u_camera) * u_zoom;
  vec2 clip   = screen / (u_resolution * 0.5);
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_color = a_color;
}
`;

const ARROW_FRAG_SRC = /* glsl */ `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 outColor;
void main() {
  outColor = v_color;
}
`;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NodeVisual {
  radius: number;
  /** Explicit RGBA color. When undefined, the renderer uses --color-outline from CSS. */
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

// Floats per node instance
const NODE_STRIDE = 7; // x, y, radius, r, g, b, a
// Floats per edge instance (no positions baked in — GPU samples from texture)
const EDGE_STRIDE = 15; // i1, i2, width, colorSrc*4, colorTgt*4, curvature, linkType, sameComm, dashed
// Floats per arrow instance (samples position texture like edges)
const ARROW_STRIDE = 8; // i1, i2, targetRadius, size, r, g, b, a

// Triangle geometry for arrowheads
const ARROW_VERTS = new Float32Array([
  0.0,  0.55,   // tip (slightly longer)
 -0.3, -0.45,   // bottom left (narrower)
  0.3, -0.45,   // bottom right (narrower)
]);

// ─── WebGL Helpers ────────────────────────────────────────────────────────────

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(`Shader compile error: ${gl.getShaderInfoLog(s)}`);
  }
  return s;
}

function linkProgram(
  gl: WebGL2RenderingContext,
  vertSrc: string,
  fragSrc: string,
): WebGLProgram {
  const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vert);
  gl.attachShader(prog, frag);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`Program link error: ${gl.getProgramInfoLog(prog)}`);
  }
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  return prog;
}

// ─── CSS colour helpers (theme-reactive) ────────────────────────────────────

function hexToTuple(hex: string, alpha = 1): [number, number, number, number] {
  const c = hex.replace('#', '');
  const len = c.length;
  let r = 0, g = 0, b = 0;
  if (len === 3) {
    r = parseInt(c[0] + c[0], 16);
    g = parseInt(c[1] + c[1], 16);
    b = parseInt(c[2] + c[2], 16);
  } else if (len >= 6) {
    r = parseInt(c.slice(0, 2), 16);
    g = parseInt(c.slice(2, 4), 16);
    b = parseInt(c.slice(4, 6), 16);
  }
  return [r / 255, g / 255, b / 255, alpha];
}

const cssCache: {
  nodeDefault: [number, number, number, number] | null;
  edge: [number, number, number, number] | null;
  edgeCooccurrence: [number, number, number, number] | null;
  edgePath: [number, number, number, number] | null;
  nodePath: [number, number, number, number] | null;
} = { nodeDefault: null, edge: null, edgeCooccurrence: null, edgePath: null, nodePath: null };

function invalidateCssCache() {
  cssCache.nodeDefault = null;
  cssCache.edge = null;
  cssCache.edgeCooccurrence = null;
  cssCache.edgePath = null;
  cssCache.nodePath = null;
}

let themeObserverReady = false;
function ensureThemeObserver() {
  if (themeObserverReady || typeof MutationObserver === 'undefined') return;
  themeObserverReady = true;
  new MutationObserver(invalidateCssCache).observe(
    document.documentElement,
    { attributes: true, attributeFilter: ['data-theme', 'class'] },
  );
}

function getCssNodeDefaultColor(): [number, number, number, number] {
  if (!cssCache.nodeDefault) {
    const val = getComputedStyle(document.documentElement)
      .getPropertyValue('--graph-node-default').trim();
    if (val && val.startsWith('#')) {
      cssCache.nodeDefault = hexToTuple(val);
    } else {
      const fallback = getComputedStyle(document.documentElement)
        .getPropertyValue('--color-on-surface-variant').trim();
      cssCache.nodeDefault = fallback ? hexToTuple(fallback) : [0.72, 0.72, 0.72, 1.0];
    }
  }
  return cssCache.nodeDefault;
}

export function getCssEdgeColor(): [number, number, number, number] {
  if (!cssCache.edge) {
    const val = getComputedStyle(document.documentElement)
      .getPropertyValue('--graph-edge-color').trim();
    if (val && val.startsWith('#')) {
      cssCache.edge = hexToTuple(val, 1.0);
    } else {
      cssCache.edge = [0.38, 0.38, 0.38, 0.6];
    }
  }
  return cssCache.edge;
}

function readCssColor(varName: string, fallback: [number, number, number, number]): [number, number, number, number] {
  const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (val && val.startsWith('#')) {
    return hexToTuple(val, 1.0);
  }
  return fallback;
}

export function getCssEdgeCooccurrenceColor(): [number, number, number, number] {
  if (!cssCache.edgeCooccurrence) {
    cssCache.edgeCooccurrence = readCssColor('--graph-edge-cooccurrence', [0.65, 0.3, 0.9, 1.0]);
  }
  return cssCache.edgeCooccurrence;
}

export function getCssEdgePathColor(): [number, number, number, number] {
  if (!cssCache.edgePath) {
    cssCache.edgePath = readCssColor('--graph-edge-path', [0.98, 0.73, 0.14, 0.9]);
  }
  return cssCache.edgePath;
}

export function getCssNodePathColor(): Float32Array {
  if (!cssCache.nodePath) {
    const c = readCssColor('--graph-node-path', [0.98, 0.73, 0.14, 1.0]);
    cssCache.nodePath = c;
  }
  return new Float32Array(cssCache.nodePath);
}

// Unit quad: 6 vertices (2 triangles), each a vec2 in [-0.5, 0.5]
const QUAD_VERTS = new Float32Array([
  -0.5, -0.5,
   0.5, -0.5,
   0.5,  0.5,
  -0.5, -0.5,
   0.5,  0.5,
  -0.5,  0.5,
]);

// Edge quad: local coords. x=side(-0.5|+0.5), y=t(0|1)
const EDGE_QUAD_VERTS = new Float32Array([
  -0.5, 0.0,
   0.5, 0.0,
   0.5, 1.0,
  -0.5, 0.0,
   0.5, 1.0,
  -0.5, 1.0,
]);

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
}

// ─── Main Renderer Class ──────────────────────────────────────────────────────

export class GraphWebGLRenderer {
  private gl: WebGL2RenderingContext | null = null;

  // --- Programs ---
  private nodeProg: WebGLProgram | null = null;
  private edgeProg: WebGLProgram | null = null;
  private ringProg: WebGLProgram | null = null;
  private arrowProg: WebGLProgram | null = null;

  // --- Node VAO / buffers ---
  private nodeVAO: WebGLVertexArrayObject | null = null;
  private nodeQuadBuf: WebGLBuffer | null = null;   // static geometry
  private nodeInstBuf: WebGLBuffer | null = null;   // dynamic instances
  private nodeInstCapacity = 0;                      // allocated floats
  private nodeInstData: Float32Array = new Float32Array(0);
  private nodeInstCount = 0;

  // --- Edge VAO / buffers (STATIC topology) ---
  private edgeVAO: WebGLVertexArrayObject | null = null;
  private edgeQuadBuf: WebGLBuffer | null = null;
  private edgeInstBuf: WebGLBuffer | null = null;
  private edgeInstCapacity = 0;
  private edgeInstData: Float32Array = new Float32Array(0);
  private edgeInstCount = 0;

  // --- Ring VAO / buffer (hover + selection highlight) ---
  // Reuses NODE_STRIDE layout; at most 2 instances (hover + selected).
  private ringVAO: WebGLVertexArrayObject | null = null;
  private ringQuadBuf: WebGLBuffer | null = null;
  private ringInstBuf: WebGLBuffer | null = null;
  private readonly ringInstData = new Float32Array(NODE_STRIDE * 2); // max 2 rings
  private ringInstCount = 0;
  private ringUniforms: {
    resolution: WebGLUniformLocation | null;
    camera:     WebGLUniformLocation | null;
    zoom:       WebGLUniformLocation | null;
  } = { resolution: null, camera: null, zoom: null };

  // --- Arrow VAO / buffer (directional arrowheads on edges) ---
  private arrowVAO: WebGLVertexArrayObject | null = null;
  private arrowTriBuf: WebGLBuffer | null = null;
  private arrowInstBuf: WebGLBuffer | null = null;
  private arrowInstCapacity = 0;
  private arrowInstData: Float32Array = new Float32Array(0);
  private arrowInstCount = 0;
  private arrowUniforms: {
    resolution: WebGLUniformLocation | null;
    camera:     WebGLUniformLocation | null;
    zoom:       WebGLUniformLocation | null;
    positions:  WebGLUniformLocation | null;
    minRadiusPx: WebGLUniformLocation | null;
  } = { resolution: null, camera: null, zoom: null, positions: null, minRadiusPx: null };

  // --- Hover / selection state ---
  private _hoveredNodeId  = '';
  private _selectedNodeId = '';
  private _hoveredEdgeIndex = -1;
  private _edgeMask = 0xFFFFFFFF; // show all link types by default
  private _communityDim = 1.0;
  private _hoverEdgeAlpha = 1.0;

  // --- Position texture (RG32F) ---
  // Uploaded once per physics frame; edge shader samples by node index.
  // Eliminates all per-frame O(E) edge CPU work.
  private posTex: WebGLTexture | null = null;
  private posTexWidth = 0; // currently allocated texture width (= node count)

  // --- Camera ---
  private camera: CameraState = { x: 0, y: 0, zoom: 1 };
  private canvasW = 1;
  private canvasH = 1;

  // --- Node metadata (maintained separately from position buffer) ---
  /** nodeId → index into current positions array */
  private nodeIndex = new Map<string, number>();
  /** nodeId → NodeVisual */
  private nodeVisuals = new Map<string, NodeVisual>();
  /** Sorted list of nodeIds in the same order received from worker */
  private nodeIdOrder: string[] = [];
  /** Latest position buffer from physics worker */
  private positions: Float32Array = new Float32Array(0);

  // --- Edge topology ---
  private edges: RendererEdge[] = [];

  // --- Adjacency for dimming ---
  private _adjacency = new Map<string, Set<string>>();
  /** Set of nodeIds that are "highlighted" (hovered/selected + their direct neighbours). */
  private _highlightedIds = new Set<string>();
  /** When true, repack node instances to apply updated dim factors. */
  private _dimDirty = false;
  /** Alpha multiplier for dimmed (non-highlighted) nodes. */
  private readonly DIM_ALPHA = 0.55;

  // --- Cached uniform locations (looked up once at init, not per frame) ---
  private nodeUniforms: {
    resolution: WebGLUniformLocation | null;
    camera: WebGLUniformLocation | null;
    zoom: WebGLUniformLocation | null;
    minRadiusPx: WebGLUniformLocation | null;
  } = { resolution: null, camera: null, zoom: null, minRadiusPx: null };

  private edgeUniforms: {
    resolution: WebGLUniformLocation | null;
    camera: WebGLUniformLocation | null;
    zoom: WebGLUniformLocation | null;
    positions: WebGLUniformLocation | null;
    edgeMask: WebGLUniformLocation | null;
    communityDim: WebGLUniformLocation | null;
    hoverEdgeAlpha: WebGLUniformLocation | null;
  } = { resolution: null, camera: null, zoom: null, positions: null, edgeMask: null, communityDim: null, hoverEdgeAlpha: null };

  // --- Pre-allocated typed arrays for uniforms (zero per-frame GC) ---
  private readonly _resBuf = new Float32Array(2);
  private readonly _camBuf = new Float32Array(2);

  // --- Fine-grained dirty flags ---
  /** True when physics delivered new positions → upload texture + repack nodes. */
  private _posDirty = false;
  /** True when edges or node IDs changed → rebuild static edge instance buffer. */
  private _edgeDirty = false;

  // --- Options ---
  private opts: Required<RendererOptions>;

  constructor(opts: RendererOptions = {}) {
    this.opts = {
      defaultRadius: opts.defaultRadius ?? 8,
      edgeWidth: opts.edgeWidth ?? 0.8,
      arrowSize: opts.arrowSize ?? 2.2,
      minNodeRadiusPx: opts.minNodeRadiusPx ?? MIN_NODE_SCREEN_RADIUS_PX,
      cullMargin: opts.cullMargin ?? 150,
      initialCapacity: opts.initialCapacity ?? 512,
    };
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /** Attach to a canvas element and initialise WebGL2. */
  init(canvas: HTMLCanvasElement): void {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: true,
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null;

    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,       gl.ONE_MINUS_SRC_ALPHA,
    );
    gl.clearColor(0, 0, 0, 0);

    this.nodeProg = linkProgram(gl, NODE_VERT_SRC, NODE_FRAG_SRC);
    this.edgeProg = linkProgram(gl, EDGE_VERT_SRC, EDGE_FRAG_SRC);
    this.ringProg = linkProgram(gl, RING_VERT_SRC, RING_FRAG_SRC);
    this.arrowProg = linkProgram(gl, ARROW_VERT_SRC, ARROW_FRAG_SRC);

    // Cache uniform locations once — they never change after linking
    this.nodeUniforms = {
      resolution: gl.getUniformLocation(this.nodeProg, 'u_resolution'),
      camera:     gl.getUniformLocation(this.nodeProg, 'u_camera'),
      zoom:       gl.getUniformLocation(this.nodeProg, 'u_zoom'),
      minRadiusPx: gl.getUniformLocation(this.nodeProg, 'u_minRadiusPx'),
    };
    this.edgeUniforms = {
      resolution: gl.getUniformLocation(this.edgeProg, 'u_resolution'),
      camera:     gl.getUniformLocation(this.edgeProg, 'u_camera'),
      zoom:       gl.getUniformLocation(this.edgeProg, 'u_zoom'),
      positions:  gl.getUniformLocation(this.edgeProg, 'u_positions'),
      edgeMask:   gl.getUniformLocation(this.edgeProg, 'u_edgeMask'),
      communityDim: gl.getUniformLocation(this.edgeProg, 'u_communityDim'),
      hoverEdgeAlpha: gl.getUniformLocation(this.edgeProg, 'u_hoverEdgeAlpha'),
    };
    this.ringUniforms = {
      resolution: gl.getUniformLocation(this.ringProg, 'u_resolution'),
      camera:     gl.getUniformLocation(this.ringProg, 'u_camera'),
      zoom:       gl.getUniformLocation(this.ringProg, 'u_zoom'),
    };
    this.arrowUniforms = {
      resolution: gl.getUniformLocation(this.arrowProg, 'u_resolution'),
      camera:     gl.getUniformLocation(this.arrowProg, 'u_camera'),
      zoom:       gl.getUniformLocation(this.arrowProg, 'u_zoom'),
      positions:  gl.getUniformLocation(this.arrowProg, 'u_positions'),
      minRadiusPx: gl.getUniformLocation(this.arrowProg, 'u_minRadiusPx'),
    };

    this._initNodeBuffers();
    this._initEdgeBuffers();
    this._initRingBuffers();
    this._initArrowBuffers();
    this._initPositionTexture();
    ensureThemeObserver();

    this.canvasW = canvas.width;
    this.canvasH = canvas.height;
    gl.viewport(0, 0, this.canvasW, this.canvasH);
  }

  /** Release all WebGL resources. */
  destroy(): void {
    const gl = this.gl;
    if (!gl) return;

    gl.deleteProgram(this.nodeProg);
    gl.deleteProgram(this.edgeProg);
    gl.deleteProgram(this.ringProg);
    gl.deleteProgram(this.arrowProg);
    gl.deleteBuffer(this.nodeQuadBuf);
    gl.deleteBuffer(this.nodeInstBuf);
    gl.deleteBuffer(this.edgeQuadBuf);
    gl.deleteBuffer(this.edgeInstBuf);
    gl.deleteBuffer(this.ringQuadBuf);
    gl.deleteBuffer(this.ringInstBuf);
    gl.deleteBuffer(this.arrowTriBuf);
    gl.deleteBuffer(this.arrowInstBuf);
    gl.deleteVertexArray(this.nodeVAO);
    gl.deleteVertexArray(this.edgeVAO);
    gl.deleteVertexArray(this.ringVAO);
    gl.deleteVertexArray(this.arrowVAO);
    gl.deleteTexture(this.posTex);

    this.gl = null;
  }

  // ─── Buffer Setup ──────────────────────────────────────────────────────────

  private _initNodeBuffers(): void {
    const gl = this.gl!;
    this.nodeVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.nodeVAO);

    // Static quad geometry
    this.nodeQuadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeQuadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTS, gl.STATIC_DRAW);

    const aQuad = gl.getAttribLocation(this.nodeProg!, 'a_quad');
    gl.enableVertexAttribArray(aQuad);
    gl.vertexAttribPointer(aQuad, 2, gl.FLOAT, false, 0, 0);

    // Dynamic instance buffer
    this.nodeInstCapacity = this.opts.initialCapacity * NODE_STRIDE;
    this.nodeInstData     = new Float32Array(this.nodeInstCapacity);
    this.nodeInstBuf      = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeInstBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.nodeInstData, gl.DYNAMIC_DRAW);

    const STRIDE = NODE_STRIDE * 4; // bytes
    const aPos    = gl.getAttribLocation(this.nodeProg!, 'a_pos');
    const aRadius = gl.getAttribLocation(this.nodeProg!, 'a_radius');
    const aColor  = gl.getAttribLocation(this.nodeProg!, 'a_color');

    // a_pos: vec2 at offset 0
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, STRIDE, 0);
    gl.vertexAttribDivisor(aPos, 1);

    // a_radius: float at offset 8
    gl.enableVertexAttribArray(aRadius);
    gl.vertexAttribPointer(aRadius, 1, gl.FLOAT, false, STRIDE, 8);
    gl.vertexAttribDivisor(aRadius, 1);

    // a_color: vec4 at offset 12
    gl.enableVertexAttribArray(aColor);
    gl.vertexAttribPointer(aColor, 4, gl.FLOAT, false, STRIDE, 12);
    gl.vertexAttribDivisor(aColor, 1);

    gl.bindVertexArray(null);
  }

  private _initArrowBuffers(): void {
    const gl = this.gl!;
    this.arrowVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.arrowVAO);

    // Static triangle geometry
    this.arrowTriBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.arrowTriBuf);
    gl.bufferData(gl.ARRAY_BUFFER, ARROW_VERTS, gl.STATIC_DRAW);

    const aLocal = gl.getAttribLocation(this.arrowProg!, 'a_local');
    gl.enableVertexAttribArray(aLocal);
    gl.vertexAttribPointer(aLocal, 2, gl.FLOAT, false, 0, 0);

    // Instance buffer: ARROW_STRIDE = 8 floats
    this.arrowInstCapacity = this.opts.initialCapacity * ARROW_STRIDE;
    this.arrowInstData = new Float32Array(this.arrowInstCapacity);
    this.arrowInstBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.arrowInstBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.arrowInstData, gl.DYNAMIC_DRAW);

    const STRIDE = ARROW_STRIDE * 4; // 32 bytes
    const aI1 = gl.getAttribLocation(this.arrowProg!, 'a_i1');
    const aI2 = gl.getAttribLocation(this.arrowProg!, 'a_i2');
    const aTargetRadius = gl.getAttribLocation(this.arrowProg!, 'a_targetRadius');
    const aSize = gl.getAttribLocation(this.arrowProg!, 'a_size');
    const aColor = gl.getAttribLocation(this.arrowProg!, 'a_color');

    gl.enableVertexAttribArray(aI1);
    gl.vertexAttribPointer(aI1, 1, gl.FLOAT, false, STRIDE, 0);
    gl.vertexAttribDivisor(aI1, 1);

    gl.enableVertexAttribArray(aI2);
    gl.vertexAttribPointer(aI2, 1, gl.FLOAT, false, STRIDE, 4);
    gl.vertexAttribDivisor(aI2, 1);

    gl.enableVertexAttribArray(aTargetRadius);
    gl.vertexAttribPointer(aTargetRadius, 1, gl.FLOAT, false, STRIDE, 8);
    gl.vertexAttribDivisor(aTargetRadius, 1);

    gl.enableVertexAttribArray(aSize);
    gl.vertexAttribPointer(aSize, 1, gl.FLOAT, false, STRIDE, 12);
    gl.vertexAttribDivisor(aSize, 1);

    gl.enableVertexAttribArray(aColor);
    gl.vertexAttribPointer(aColor, 4, gl.FLOAT, false, STRIDE, 16);
    gl.vertexAttribDivisor(aColor, 1);

    gl.bindVertexArray(null);
  }

  private _initEdgeBuffers(): void {
    const gl = this.gl!;
    this.edgeVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.edgeVAO);

    // Static edge quad geometry
    this.edgeQuadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeQuadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, EDGE_QUAD_VERTS, gl.STATIC_DRAW);

    const aLocal = gl.getAttribLocation(this.edgeProg!, 'a_local');
    gl.enableVertexAttribArray(aLocal);
    gl.vertexAttribPointer(aLocal, 2, gl.FLOAT, false, 0, 0);

    // Static topology instance buffer
    // Layout: i1, i2, width, colorSrc(4), colorTgt(4), curvature, linkType, sameComm, dashed = 14 floats
    this.edgeInstCapacity = this.opts.initialCapacity * EDGE_STRIDE;
    this.edgeInstData     = new Float32Array(this.edgeInstCapacity);
    this.edgeInstBuf      = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeInstBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.edgeInstData, gl.DYNAMIC_DRAW);

    const STRIDE  = EDGE_STRIDE * 4; // 56 bytes
    const aI1         = gl.getAttribLocation(this.edgeProg!, 'a_i1');
    const aI2         = gl.getAttribLocation(this.edgeProg!, 'a_i2');
    const aWidth      = gl.getAttribLocation(this.edgeProg!, 'a_width');
    const aColorSrc   = gl.getAttribLocation(this.edgeProg!, 'a_colorSrc');
    const aColorTgt   = gl.getAttribLocation(this.edgeProg!, 'a_colorTgt');
    const aCurvature  = gl.getAttribLocation(this.edgeProg!, 'a_curvature');
    const aLinkType   = gl.getAttribLocation(this.edgeProg!, 'a_linkType');
    const aSameComm   = gl.getAttribLocation(this.edgeProg!, 'a_sameComm');
    const aDashed     = gl.getAttribLocation(this.edgeProg!, 'a_dashed');

    let off = 0;
    gl.enableVertexAttribArray(aI1);
    gl.vertexAttribPointer(aI1, 1, gl.FLOAT, false, STRIDE, off);
    gl.vertexAttribDivisor(aI1, 1); off += 4;

    gl.enableVertexAttribArray(aI2);
    gl.vertexAttribPointer(aI2, 1, gl.FLOAT, false, STRIDE, off);
    gl.vertexAttribDivisor(aI2, 1); off += 4;

    gl.enableVertexAttribArray(aWidth);
    gl.vertexAttribPointer(aWidth, 1, gl.FLOAT, false, STRIDE, off);
    gl.vertexAttribDivisor(aWidth, 1); off += 4;

    gl.enableVertexAttribArray(aColorSrc);
    gl.vertexAttribPointer(aColorSrc, 4, gl.FLOAT, false, STRIDE, off);
    gl.vertexAttribDivisor(aColorSrc, 1); off += 16;

    gl.enableVertexAttribArray(aColorTgt);
    gl.vertexAttribPointer(aColorTgt, 4, gl.FLOAT, false, STRIDE, off);
    gl.vertexAttribDivisor(aColorTgt, 1); off += 16;

    gl.enableVertexAttribArray(aCurvature);
    gl.vertexAttribPointer(aCurvature, 1, gl.FLOAT, false, STRIDE, off);
    gl.vertexAttribDivisor(aCurvature, 1); off += 4;

    gl.enableVertexAttribArray(aLinkType);
    gl.vertexAttribPointer(aLinkType, 1, gl.FLOAT, false, STRIDE, off);
    gl.vertexAttribDivisor(aLinkType, 1); off += 4;

    gl.enableVertexAttribArray(aSameComm);
    gl.vertexAttribPointer(aSameComm, 1, gl.FLOAT, false, STRIDE, off);
    gl.vertexAttribDivisor(aSameComm, 1); off += 4;

    if (aDashed >= 0) {
      gl.enableVertexAttribArray(aDashed);
      gl.vertexAttribPointer(aDashed, 1, gl.FLOAT, false, STRIDE, off);
      gl.vertexAttribDivisor(aDashed, 1);
    }

    gl.bindVertexArray(null);
  }

  private _initPositionTexture(): void {
    const gl = this.gl!;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // Nearest filtering — we use exact texelFetch, no interpolation
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.posTex = tex;
    // Reset so that the first upload always calls texImage2D (not texSubImage2D
    // on an uninitialised texture), even when init() is called more than once.
    this.posTexWidth = 0;
  }

  private _initRingBuffers(): void {
    const gl = this.gl!;
    this.ringVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.ringVAO);

    // Reuse the same unit quad geometry
    this.ringQuadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ringQuadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTS, gl.STATIC_DRAW);

    const aQuad = gl.getAttribLocation(this.ringProg!, 'a_quad');
    gl.enableVertexAttribArray(aQuad);
    gl.vertexAttribPointer(aQuad, 2, gl.FLOAT, false, 0, 0);

    // Dynamic instance buffer — max 2 rings (hover + selected), NODE_STRIDE layout
    this.ringInstBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ringInstBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.ringInstData, gl.DYNAMIC_DRAW);

    const STRIDE  = NODE_STRIDE * 4;
    const aPos    = gl.getAttribLocation(this.ringProg!, 'a_pos');
    const aRadius = gl.getAttribLocation(this.ringProg!, 'a_radius');
    const aColor  = gl.getAttribLocation(this.ringProg!, 'a_color');

    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, STRIDE, 0);
    gl.vertexAttribDivisor(aPos, 1);

    gl.enableVertexAttribArray(aRadius);
    gl.vertexAttribPointer(aRadius, 1, gl.FLOAT, false, STRIDE, 8);
    gl.vertexAttribDivisor(aRadius, 1);

    gl.enableVertexAttribArray(aColor);
    gl.vertexAttribPointer(aColor, 4, gl.FLOAT, false, STRIDE, 12);
    gl.vertexAttribDivisor(aColor, 1);

    gl.bindVertexArray(null);
  }

  // ─── Dynamic updates ───────────────────────────────────────────────────────

  /**
   * Called when the worker sends a new topology.
   * Associates nodeId → visual metadata; rebuilds the index map.
   */
  setNodeVisuals(
    nodeIds: ArrayLike<string>,
    visuals: Map<string, NodeVisual>,
  ): void {
    this.nodeVisuals = visuals;
    const n = nodeIds.length;
    this.nodeIdOrder = new Array<string>(n);
    this.nodeIndex.clear();
    for (let i = 0; i < n; i++) {
      const id = nodeIds[i];
      this.nodeIdOrder[i] = id;
      this.nodeIndex.set(id, i);
    }
    // Node indices changed — edge topology needs re-resolution
    this._edgeDirty = true;
    this._posDirty  = true;
  }

  /** Replace the edge list. Edges reference node IDs. */
  setEdges(edges: RendererEdge[]): void {
    this.edges = edges;
    this._edgeDirty = true;
    this._rebuildAdjacency();
    this._recomputeHighlighted();
  }

  // ─── Adjacency + Dimming ────────────────────────────────────────────────────────

  private _rebuildAdjacency(): void {
    this._adjacency.clear();
    for (const { source, target } of this.edges) {
      if (!this._adjacency.has(source)) this._adjacency.set(source, new Set());
      if (!this._adjacency.has(target)) this._adjacency.set(target, new Set());
      this._adjacency.get(source)!.add(target);
      this._adjacency.get(target)!.add(source);
    }
  }

  private _recomputeHighlighted(): void {
    this._highlightedIds.clear();
    // Dimming is driven only by selection — hover does not dim other nodes.
    const focusIds = [this._selectedNodeId].filter(id => id !== '');
    if (focusIds.length === 0) {
      this._dimDirty = true;
      this._edgeDirty = true; // rebuild edges without dimming
      return;
    }
    for (const id of focusIds) {
      this._highlightedIds.add(id);
      const neighbours = this._adjacency.get(id);
      if (neighbours) for (const nb of neighbours) this._highlightedIds.add(nb);
    }
    this._dimDirty = true;
    this._edgeDirty = true; // rebuild edges with dimming
  }

  /**
   * Called every physics frame with the latest positions.
   * positions: Float32Array [x0, y0, x1, y1, …] length = nodeCount * 2.
   * nodeIds accompanies positions (same order).
   */
  updatePositions(positions: Float32Array, nodeIds: string[]): void {
    this.positions = positions;
    // Rebuild the index map in case topology changed (nodeIds re-sent on init/setTopology)
    if (nodeIds.length !== this.nodeIdOrder.length) {
      this.nodeIndex.clear();
      this.nodeIdOrder = nodeIds.slice();
      for (let i = 0; i < nodeIds.length; i++) {
        this.nodeIndex.set(nodeIds[i], i);
      }
      // Node order changed — re-resolve edge indices
      this._edgeDirty = true;
    }
    this._posDirty = true;
  }

  /** Override a single node's position (e.g., during drag on main thread). */
  overridePosition(nodeId: string, x: number, y: number): void {
    const idx = this.nodeIndex.get(nodeId);
    if (idx === undefined) return;
    if (this.positions.length >= (idx + 1) * 2) {
      this.positions[idx * 2]     = x;
      this.positions[idx * 2 + 1] = y;
      this._posDirty = true;
    }
  }

  // ─── Camera ────────────────────────────────────────────────────────────────

  setCamera(x: number, y: number, zoom: number): void {
    this.camera = { x, y, zoom };
    // Camera is only a uniform — no dirty flag needed, no CPU repack required.
  }

  /** Signal the renderer which node is currently hovered (for ring + dimming). */
  setHoveredNode(id: string): void {
    if (this._hoveredNodeId === id) return;
    this._hoveredNodeId = id;
    this._recomputeHighlighted();
  }

  /** Signal the renderer which node is currently selected (for ring + dimming). */
  setSelectedNode(id: string): void {
    if (this._selectedNodeId === id) return;
    this._selectedNodeId = id;
    this._recomputeHighlighted();
  }

  /** Read-only access to the latest physics positions (for label rendering). */
  get nodePositions(): Float32Array { return this.positions; }
  /** Read-only ordered list of node IDs (index matches nodePositions). */
  get nodeOrder(): string[] { return this.nodeIdOrder; }

  /** Convert world-space coords to canvas-pixel coords. */
  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    const { x: cx, y: cy, zoom } = this.camera;
    return {
      x: (wx - cx) * zoom + this.canvasW * 0.5,
      y: (wy - cy) * zoom + this.canvasH * 0.5,
    };
  }

  /** Call after canvas resize. */
  resize(w: number, h: number): void {
    const gl = this.gl;
    if (!gl) return;
    this.canvasW = w;
    this.canvasH = h;
    gl.viewport(0, 0, w, h);
  }

  // ─── Packing ───────────────────────────────────────────────────────────────

  private _packNodeInstances(): void {
    const n = this.nodeIdOrder.length;
    const needed = n * NODE_STRIDE;

    if (this.nodeInstCapacity < needed) {
      // Grow by 1.5×
      this.nodeInstCapacity = Math.ceil(needed * 1.5);
      this.nodeInstData = new Float32Array(this.nodeInstCapacity);

      // Reallocate GPU buffer
      const gl = this.gl!;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeInstBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.nodeInstCapacity * 4, gl.DYNAMIC_DRAW);
    }

    const pos = this.positions;
    const defaultColor = getCssNodeDefaultColor();
    const hasFocus = this._highlightedIds.size > 0;

    // No CPU culling — GPU clip space discards off-screen quads for free.
    for (let i = 0; i < n; i++) {
      const id     = this.nodeIdOrder[i];
      const vis    = this.nodeVisuals.get(id);
      const radius = vis?.radius ?? this.opts.defaultRadius;
      const color  = vis?.color;
      const def    = color ? null : defaultColor;

      // Dimming: non-highlighted nodes fade when something is focused
      const dimmed = hasFocus && !this._highlightedIds.has(id);
      const pinBrighten = vis?.pin ? 1.2 : 1.0;

      const base = i * NODE_STRIDE;
      this.nodeInstData[base    ] = pos[i * 2];
      this.nodeInstData[base + 1] = pos[i * 2 + 1];
      this.nodeInstData[base + 2] = radius;
      this.nodeInstData[base + 3] = Math.min(1, (color ? color[0] : def![0]) * pinBrighten);
      this.nodeInstData[base + 4] = Math.min(1, (color ? color[1] : def![1]) * pinBrighten);
      this.nodeInstData[base + 5] = Math.min(1, (color ? color[2] : def![2]) * pinBrighten);
      const baseAlpha             = color ? color[3] : def![3];
      this.nodeInstData[base + 6] = dimmed ? baseAlpha * this.DIM_ALPHA : baseAlpha;
    }

    this.nodeInstCount = n;

    const gl = this.gl!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeInstBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.nodeInstData, 0, n * NODE_STRIDE);
  }

  /**
   * Upload the current positions Float32Array directly as an RG32F texture.
   * Each texel (i, 0) stores (x, y) for node i.
   * This is a single DMA transfer — the positions buffer IS the texture data.
   */
  private _uploadPositionTexture(): void {
    const gl = this.gl!;
    const n = this.nodeIdOrder.length;
    if (n === 0 || !this.posTex) return;
    // Positions buffer not yet received from physics worker — skip silently.
    if (this.positions.length < n * 2) return;

    gl.bindTexture(gl.TEXTURE_2D, this.posTex);

    if (n !== this.posTexWidth) {
      // Reallocate texture storage for new node count
      gl.texImage2D(
        gl.TEXTURE_2D, 0,
        gl.RG32F,        // internal format: two 32-bit floats per texel
        n, 1, 0,
        gl.RG, gl.FLOAT,
        this.positions.subarray(0, n * 2),
      );
      this.posTexWidth = n;
    } else {
      // Update existing allocation (no GPU realloc — cheaper)
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0,
        0, 0, n, 1,
        gl.RG, gl.FLOAT,
        this.positions.subarray(0, n * 2),
      );
    }

    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /**
   * Resolve edge source/target IDs → node indices and pack into the static
   * edge instance buffer.  Runs ONLY on topology change, never when nodes move.
   */
  private _rebuildEdgeTopology(): void {
    const edges = this.edges;
    const ne = edges.length;
    const needed = ne * EDGE_STRIDE;

    if (this.edgeInstCapacity < needed) {
      this.edgeInstCapacity = Math.ceil(needed * 1.5);
      this.edgeInstData = new Float32Array(this.edgeInstCapacity);

      const gl = this.gl!;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeInstBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.edgeInstCapacity * 4, gl.DYNAMIC_DRAW);
    }

    const defaultColor = getCssEdgeColor();
    const hasFocus = this._highlightedIds.size > 0;

    let count = 0;
    for (let i = 0; i < ne; i++) {
      const e = edges[i];
      const si = this.nodeIndex.get(e.source);
      const ti = this.nodeIndex.get(e.target);
      if (si === undefined || ti === undefined) continue;

      const srcVis = this.nodeVisuals.get(e.source);
      const tgtVis = this.nodeVisuals.get(e.target);
      const srcColor = e.colorSrc ?? e.color ?? srcVis?.color ?? defaultColor;
      const tgtColor = e.colorTgt ?? e.color ?? tgtVis?.color ?? defaultColor;

      // Edge dimming: edges not touching a highlighted node fade out
      const edgeHighlighted = !hasFocus || this._highlightedIds.has(e.source) || this._highlightedIds.has(e.target);
      const dimMult = edgeHighlighted ? 1.0 : this.DIM_ALPHA;

      // Store indices as floats — shader casts to int via int()
      const base = count * EDGE_STRIDE;
      this.edgeInstData[base     ] = si;           // source node index
      this.edgeInstData[base +  1] = ti;           // target node index
      this.edgeInstData[base +  2] = e.width ?? this.opts.edgeWidth;
      this.edgeInstData[base +  3] = srcColor[0];
      this.edgeInstData[base +  4] = srcColor[1];
      this.edgeInstData[base +  5] = srcColor[2];
      this.edgeInstData[base +  6] = srcColor[3] * dimMult;
      this.edgeInstData[base +  7] = tgtColor[0];
      this.edgeInstData[base +  8] = tgtColor[1];
      this.edgeInstData[base +  9] = tgtColor[2];
      this.edgeInstData[base + 10] = tgtColor[3] * dimMult;
      this.edgeInstData[base + 11] = e.curvature ?? 0.0;
      this.edgeInstData[base + 12] = e.linkType ?? 0.0;
      this.edgeInstData[base + 13] = 1.0; // sameCommunity placeholder
      this.edgeInstData[base + 14] = e.dashed ? 1.0 : 0.0; // dashed flag
      count++;
    }

    this.edgeInstCount = count;

    const gl = this.gl!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeInstBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.edgeInstData, 0, count * EDGE_STRIDE);

    // Rebuild arrow topology whenever edges change (same dependency set)
    this._rebuildArrowTopology();
  }

  /**
   * Pack arrowhead instances. Arrows are drawn at the target end of each edge.
   * Samples positions from the texture so this only needs to run on topology change.
   */
  private _rebuildArrowTopology(): void {
    const edges = this.edges;
    const ne = edges.length;
    const needed = ne * ARROW_STRIDE;

    if (this.arrowInstCapacity < needed) {
      this.arrowInstCapacity = Math.ceil(needed * 1.5);
      this.arrowInstData = new Float32Array(this.arrowInstCapacity);

      const gl = this.gl!;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.arrowInstBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.arrowInstCapacity * 4, gl.DYNAMIC_DRAW);
    }

    const defaultColor = getCssEdgeColor();
    const arrowSize = this.opts.arrowSize;
    const hasFocus = this._highlightedIds.size > 0;

    let count = 0;
    for (let i = 0; i < ne; i++) {
      const { source, target, color, linkType } = edges[i];
      const si = this.nodeIndex.get(source);
      const ti = this.nodeIndex.get(target);
      if (si === undefined || ti === undefined) continue;

      // Skip arrows on reference edges to reduce clutter
      if (linkType === 3 || linkType === 4) continue;

      const [er, eg, eb, ea] = color ?? defaultColor;

      // Arrow dimming follows edge dimming
      const edgeHighlighted = !hasFocus || this._highlightedIds.has(source) || this._highlightedIds.has(target);
      const finalAlpha = edgeHighlighted ? ea : ea * this.DIM_ALPHA;

      const targetRadius = this.nodeVisuals.get(target)?.radius ?? this.opts.defaultRadius;

      const base = count * ARROW_STRIDE;
      this.arrowInstData[base    ] = si;
      this.arrowInstData[base + 1] = ti;
      this.arrowInstData[base + 2] = targetRadius;
      this.arrowInstData[base + 3] = arrowSize;
      this.arrowInstData[base + 4] = er;
      this.arrowInstData[base + 5] = eg;
      this.arrowInstData[base + 6] = eb;
      this.arrowInstData[base + 7] = finalAlpha;
      count++;
    }

    this.arrowInstCount = count;

    const gl = this.gl!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.arrowInstBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.arrowInstData, 0, count * ARROW_STRIDE);
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  /** Draw one frame. Call from requestAnimationFrame callback. */
  render(): void {
    const gl = this.gl;
    if (!gl) return;

    // ── Topology rebuild (O(E), only when graph structure changes) ──
    if (this._edgeDirty) {
      this._edgeDirty = false;
      this._rebuildEdgeTopology();
    }

    // ── Position / dim update ──
    // Upload positions texture + repack node instances.
    // Camera movement does NOT reach this path — camera is just a uniform.
    // _dimDirty triggers a repack (no texture upload needed) when hover/select
    // changes so dimming is applied immediately without waiting for new physics.
    if (this._posDirty || this._dimDirty) {
      const n = this.nodeIdOrder.length;
      // Only clear the dirty flag once positions are actually available.
      if (n === 0 || this.positions.length >= n * 2) {
        if (this._posDirty) {
          this._posDirty = false;
          this._uploadPositionTexture();
        }
        this._dimDirty = false;
        this._packNodeInstances();     // O(N): positions + radii + colors + dim per node
      }
    }

    gl.clear(gl.COLOR_BUFFER_BIT);

    const { x: cx, y: cy, zoom } = this.camera;
    this._resBuf[0] = this.canvasW;
    this._resBuf[1] = this.canvasH;
    this._camBuf[0] = cx;
    this._camBuf[1] = cy;

    // ── Build hover / selection rings ────────────────────────────────
    // Written so rings are drawn BEFORE nodes (appear under the main circle).
    this.ringInstCount = 0;
    const rid = this.ringInstData;

    // Helper: write one ring instance at the given node's position.
    // Ring radius = node_radius * scale so it peeks out from behind the node.
    // Color is always taken from the node's own visual color (or CSS default).
    const minWorldRadius = this.opts.minNodeRadiusPx / (2.0 * zoom);
    const writeRing = (nodeId: string, scale: number, a: number): void => {
      const idx = this.nodeIndex.get(nodeId);
      if (idx === undefined) return;
      const px  = this.positions[idx * 2];
      const py  = this.positions[idx * 2 + 1];
      const vis = this.nodeVisuals.get(nodeId);
      const baseRadius = vis?.radius ?? this.opts.defaultRadius;
      const effBaseRadius = Math.max(baseRadius, minWorldRadius);
      const nodeCol: ArrayLike<number> = vis?.color ?? getCssNodeDefaultColor();
      const base = this.ringInstCount * NODE_STRIDE;
      rid[base    ] = px;
      rid[base + 1] = py;
      rid[base + 2] = effBaseRadius * scale;
      rid[base + 3] = nodeCol[0];
      rid[base + 4] = nodeCol[1];
      rid[base + 5] = nodeCol[2];
      rid[base + 6] = a;
      this.ringInstCount++;
    };

    // Selected: larger glare ring, fully opaque node color.
    if (this._selectedNodeId !== '') writeRing(this._selectedNodeId, 1.85, 0.80);
    // Hovered: slightly enlarged glare ring — no dimming of other nodes.
    if (this._hoveredNodeId !== '' && this._hoveredNodeId !== this._selectedNodeId) {
      writeRing(this._hoveredNodeId, 1.55, 0.45);
    }

    // ── Draw hover/selection rings (UNDER nodes) ────────────────────────────
    if (this.ringInstCount > 0 && this.ringVAO && this.positions.length > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.ringInstBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, rid, 0, this.ringInstCount * NODE_STRIDE);
      gl.useProgram(this.ringProg);
      gl.bindVertexArray(this.ringVAO);
      gl.uniform2fv(this.ringUniforms.resolution, this._resBuf);
      gl.uniform2fv(this.ringUniforms.camera, this._camBuf);
      gl.uniform1f( this.ringUniforms.zoom, zoom);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.ringInstCount);
    }

    // ── Draw edges (GPU samples positions from texture — O(1) CPU per frame) ──
    // posTexWidth > 0 ensures texImage2D has been called; skip if not yet ready.
    if (this.edgeInstCount > 0 && this.posTex && this.posTexWidth > 0) {
      gl.useProgram(this.edgeProg);
      gl.bindVertexArray(this.edgeVAO);
      gl.uniform2fv(this.edgeUniforms.resolution, this._resBuf);
      gl.uniform2fv(this.edgeUniforms.camera, this._camBuf);
      gl.uniform1f( this.edgeUniforms.zoom, zoom);
      gl.uniform1i( this.edgeUniforms.edgeMask, this._edgeMask);
      gl.uniform1f( this.edgeUniforms.communityDim, this._communityDim);
      gl.uniform1f( this.edgeUniforms.hoverEdgeAlpha, this._hoverEdgeAlpha);
      // Bind position texture to unit 0 for the edge shader
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.posTex);
      gl.uniform1i(this.edgeUniforms.positions, 0);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.edgeInstCount);
    }

    // ── Draw nodes (on top of rings and edges) ────────────────────────────
    if (this.nodeInstCount > 0) {
      gl.useProgram(this.nodeProg);
      gl.bindVertexArray(this.nodeVAO);
      gl.uniform2fv(this.nodeUniforms.resolution, this._resBuf);
      gl.uniform2fv(this.nodeUniforms.camera, this._camBuf);
      gl.uniform1f( this.nodeUniforms.zoom, zoom);
      gl.uniform1f( this.nodeUniforms.minRadiusPx, this.opts.minNodeRadiusPx);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.nodeInstCount);
    }

    // ── Draw arrowheads (on top of edges, under nodes) ────────────────────
    if (this.arrowInstCount > 0 && this.posTex && this.posTexWidth > 0) {
      gl.useProgram(this.arrowProg);
      gl.bindVertexArray(this.arrowVAO);
      gl.uniform2fv(this.arrowUniforms.resolution, this._resBuf);
      gl.uniform2fv(this.arrowUniforms.camera, this._camBuf);
      gl.uniform1f( this.arrowUniforms.zoom, zoom);
      gl.uniform1f( this.arrowUniforms.minRadiusPx, this.opts.minNodeRadiusPx);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.posTex);
      gl.uniform1i(this.arrowUniforms.positions, 0);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, this.arrowInstCount);
    }

    gl.bindVertexArray(null);
  }

  // ─── Diagnostics ───────────────────────────────────────────────────────────

  get stats() {
    return {
      nodeInstCount: this.nodeInstCount,
      edgeInstCount: this.edgeInstCount,
      arrowInstCount: this.arrowInstCount,
      nodeDataCapacity: this.nodeInstCapacity,
      edgeDataCapacity: this.edgeInstCapacity,
    };
  }

  /** World position from canvas pixel (for hit-testing & click-to-world). */
  screenToWorld(px: number, py: number): { x: number; y: number } {
    const { x: cx, y: cy, zoom } = this.camera;
    return {
      x: (px - this.canvasW * 0.5) / zoom + cx,
      y: (py - this.canvasH * 0.5) / zoom + cy,
    };
  }

  /**
   * Fit all nodes into the current canvas viewport with padding.
   * Returns the new camera state (also applied to `this.camera`).
   */
  fitToCanvas(paddingPx = 60): CameraState {
    const n = this.nodeIdOrder.length;
    if (n === 0) return { ...this.camera };

    const pos = this.positions;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pos[i * 2];
      const y = pos[i * 2 + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    // Add max node radius as world-space padding so nodes aren't clipped
    const maxRadius = this.opts.defaultRadius * 2;
    const worldW = (maxX - minX) + maxRadius * 2;
    const worldH = (maxY - minY) + maxRadius * 2;

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

  /** Find the closest node to a world-space point within maxDist world units. */
  pickNode(wx: number, wy: number, maxDist = 20): string | null {
    const pos = this.positions;
    let best = -1;
    let bestD2 = maxDist * maxDist;

    for (let i = 0; i < this.nodeIdOrder.length; i++) {
      const dx = pos[i * 2]     - wx;
      const dy = pos[i * 2 + 1] - wy;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best   = i;
      }
    }

    return best >= 0 ? this.nodeIdOrder[best] : null;
  }

  /** Find the closest edge to a world-space point within maxDist world units.
   *  Returns the edge index in the current edges array, or -1 if none is close. */
  pickEdge(wx: number, wy: number, maxDist = 10): number {
    const pos = this.positions;
    const threshold2 = maxDist * maxDist;
    let bestIdx = -1;
    let bestD2 = threshold2;

    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      const si = this.nodeIndex.get(e.source);
      const ti = this.nodeIndex.get(e.target);
      if (si === undefined || ti === undefined) continue;
      const x1 = pos[si * 2], y1 = pos[si * 2 + 1];
      const x2 = pos[ti * 2], y2 = pos[ti * 2 + 1];

      // Project (wx,wy) onto segment (x1,y1)-(x2,y2)
      const dx = x2 - x1, dy = y2 - y1;
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

  setEdgeMask(mask: number): void {
    this._edgeMask = mask;
  }

  setCommunityDim(dim: number): void {
    this._communityDim = dim;
  }

  setHoveredEdge(index: number): void {
    if (this._hoveredEdgeIndex === index) return;
    this._hoveredEdgeIndex = index;
    this._hoverEdgeAlpha = index >= 0 ? 0.35 : 1.0;
  }
}
