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

out vec2 v_uv;
out vec4 v_color;

void main() {
  v_uv    = a_quad * 2.0;  // -1..1 for SDF
  v_color = a_color;

  // world-space vertex position
  vec2 world  = a_pos + a_quad * a_radius * 2.0;
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
  float d     = length(v_uv);
  // Outer ring = hard circle, inner ring = bright core
  float alpha = 1.0 - smoothstep(0.82, 1.0, d);
  if (alpha <= 0.01) discard;

  // Slight radial highlight
  float highlight = 1.0 - smoothstep(0.0, 0.6, d) * 0.3;
  outColor = vec4(v_color.rgb * highlight, v_color.a * alpha);
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
in vec2  a_local; // x = side (-0.5..0.5), y = t (0..1 along edge)

// Per-instance — STATIC topology, no positions baked in
in float a_i1;    // source node index → texelFetch into u_positions
in float a_i2;    // target node index → texelFetch into u_positions
in float a_width; // world-space half-width
in vec4  a_color; // RGBA 0..1

// Camera
uniform vec2  u_resolution;
uniform vec2  u_camera;
uniform float u_zoom;

// RG32F position texture: texel(i, 0).rg = (x, y) for node i
uniform highp sampler2D u_positions;

out vec4 v_color;

void main() {
  v_color = a_color;

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

  vec2 base  = mix(p1, p2, a_local.y);
  vec2 world = base + perp * a_local.x * a_width;

  vec2 screen = (world - u_camera) * u_zoom;
  vec2 clip   = screen / (u_resolution * 0.5);

  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}
`;

const EDGE_FRAG_SRC = /* glsl */ `#version 300 es
precision mediump float;

in vec4 v_color;
out vec4 outColor;

void main() {
  outColor = v_color;
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

/** Ring fragment: smooth annulus between inner ~0.65 and outer ~1.0. */
const RING_FRAG_SRC = /* glsl */ `#version 300 es
precision mediump float;

in vec2 v_uv;
in vec4 v_color;
out vec4 outColor;

void main() {
  float d     = length(v_uv);
  float outer = 1.0 - smoothstep(0.90, 1.00, d);
  float inner = smoothstep(0.60, 0.72, d);
  float alpha = outer * inner;
  if (alpha <= 0.01) discard;
  outColor = vec4(v_color.rgb, v_color.a * alpha);
}
`;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NodeVisual {
  radius: number;
  /** Explicit RGBA color. When undefined, the renderer uses --color-outline from CSS. */
  color?: Float32Array;
}

export interface RendererOptions {
  /** Default node radius in world units. Default: 8 */
  defaultRadius?: number;
  /** Default edge half-width in world units. Default: 0.8 */
  edgeWidth?: number;
  /** Default edge RGBA. Default: [0.4, 0.4, 0.5, 0.35] */
  edgeColor?: [number, number, number, number];
  /** Default node RGBA when no visual provided. Default: [0.42, 0.65, 1.0, 1.0] */
  defaultNodeColor?: [number, number, number, number];
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
const EDGE_STRIDE = 7; // i1, i2, width, r, g, b, a

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
} = { nodeDefault: null, edge: null };

function invalidateCssCache() {
  cssCache.nodeDefault = null;
  cssCache.edge = null;
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
    const hex = getComputedStyle(document.documentElement)
      .getPropertyValue('--color-on-surface-variant').trim();
    cssCache.nodeDefault = hex ? hexToTuple(hex) : [0.64, 0.64, 0.64, 1.0];
  }
  return cssCache.nodeDefault;
}

function getCssEdgeColor(): [number, number, number, number] {
  if (!cssCache.edge) {
    const hex = getComputedStyle(document.documentElement)
      .getPropertyValue('--color-accent').trim();
    cssCache.edge = hex ? hexToTuple(hex, 0.55) : [0.6, 0.6, 0.6, 0.55];
  }
  return cssCache.edge;
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

// ─── Main Renderer Class ──────────────────────────────────────────────────────

export class GraphWebGLRenderer {
  private gl: WebGL2RenderingContext | null = null;

  // --- Programs ---
  private nodeProg: WebGLProgram | null = null;
  private edgeProg: WebGLProgram | null = null;
  private ringProg: WebGLProgram | null = null;

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

  // --- Hover / selection state ---
  private _hoveredNodeId  = -1;
  private _selectedNodeId = -1;

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
  private nodeIndex = new Map<number, number>();
  /** nodeId → NodeVisual */
  private nodeVisuals = new Map<number, NodeVisual>();
  /** Sorted list of nodeIds in the same order received from worker */
  private nodeIdOrder: Int32Array = new Int32Array(0);
  /** Latest position buffer from physics worker */
  private positions: Float32Array = new Float32Array(0);

  // --- Edge topology ---
  private edges: Array<{ source: number; target: number }> = [];

  // --- Cached uniform locations (looked up once at init, not per frame) ---
  private nodeUniforms: {
    resolution: WebGLUniformLocation | null;
    camera: WebGLUniformLocation | null;
    zoom: WebGLUniformLocation | null;
  } = { resolution: null, camera: null, zoom: null };

  private edgeUniforms: {
    resolution: WebGLUniformLocation | null;
    camera: WebGLUniformLocation | null;
    zoom: WebGLUniformLocation | null;
    positions: WebGLUniformLocation | null;
  } = { resolution: null, camera: null, zoom: null, positions: null };

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
      edgeColor: opts.edgeColor ?? [0.4, 0.4, 0.52, 0.35],
      defaultNodeColor: opts.defaultNodeColor ?? [0.42, 0.65, 1.0, 1.0],
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

    // Cache uniform locations once — they never change after linking
    this.nodeUniforms = {
      resolution: gl.getUniformLocation(this.nodeProg, 'u_resolution'),
      camera:     gl.getUniformLocation(this.nodeProg, 'u_camera'),
      zoom:       gl.getUniformLocation(this.nodeProg, 'u_zoom'),
    };
    this.edgeUniforms = {
      resolution: gl.getUniformLocation(this.edgeProg, 'u_resolution'),
      camera:     gl.getUniformLocation(this.edgeProg, 'u_camera'),
      zoom:       gl.getUniformLocation(this.edgeProg, 'u_zoom'),
      positions:  gl.getUniformLocation(this.edgeProg, 'u_positions'),
    };
    this.ringUniforms = {
      resolution: gl.getUniformLocation(this.ringProg, 'u_resolution'),
      camera:     gl.getUniformLocation(this.ringProg, 'u_camera'),
      zoom:       gl.getUniformLocation(this.ringProg, 'u_zoom'),
    };

    this._initNodeBuffers();
    this._initEdgeBuffers();
    this._initRingBuffers();
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
    gl.deleteBuffer(this.nodeQuadBuf);
    gl.deleteBuffer(this.nodeInstBuf);
    gl.deleteBuffer(this.edgeQuadBuf);
    gl.deleteBuffer(this.edgeInstBuf);
    gl.deleteBuffer(this.ringQuadBuf);
    gl.deleteBuffer(this.ringInstBuf);
    gl.deleteVertexArray(this.nodeVAO);
    gl.deleteVertexArray(this.edgeVAO);
    gl.deleteVertexArray(this.ringVAO);
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
    // Layout: [ i1(f32), i2(f32), width(f32), r, g, b, a ] = 7 floats = 28 bytes
    this.edgeInstCapacity = this.opts.initialCapacity * EDGE_STRIDE;
    this.edgeInstData     = new Float32Array(this.edgeInstCapacity);
    this.edgeInstBuf      = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeInstBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.edgeInstData, gl.DYNAMIC_DRAW);

    const STRIDE = EDGE_STRIDE * 4; // 28 bytes
    const aI1    = gl.getAttribLocation(this.edgeProg!, 'a_i1');
    const aI2    = gl.getAttribLocation(this.edgeProg!, 'a_i2');
    const aWidth = gl.getAttribLocation(this.edgeProg!, 'a_width');
    const aColor = gl.getAttribLocation(this.edgeProg!, 'a_color');

    // a_i1: float at offset 0
    gl.enableVertexAttribArray(aI1);
    gl.vertexAttribPointer(aI1, 1, gl.FLOAT, false, STRIDE, 0);
    gl.vertexAttribDivisor(aI1, 1);

    // a_i2: float at offset 4
    gl.enableVertexAttribArray(aI2);
    gl.vertexAttribPointer(aI2, 1, gl.FLOAT, false, STRIDE, 4);
    gl.vertexAttribDivisor(aI2, 1);

    // a_width: float at offset 8
    gl.enableVertexAttribArray(aWidth);
    gl.vertexAttribPointer(aWidth, 1, gl.FLOAT, false, STRIDE, 8);
    gl.vertexAttribDivisor(aWidth, 1);

    // a_color: vec4 at offset 12
    gl.enableVertexAttribArray(aColor);
    gl.vertexAttribPointer(aColor, 4, gl.FLOAT, false, STRIDE, 12);
    gl.vertexAttribDivisor(aColor, 1);

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
    nodeIds: ArrayLike<number>,
    visuals: Map<number, NodeVisual>,
  ): void {
    this.nodeVisuals = visuals;
    const n = nodeIds.length;
    this.nodeIdOrder = new Int32Array(n);
    this.nodeIndex.clear();
    for (let i = 0; i < n; i++) {
      const id = (nodeIds as Int32Array)[i];
      this.nodeIdOrder[i] = id;
      this.nodeIndex.set(id, i);
    }
    // Node indices changed — edge topology needs re-resolution
    this._edgeDirty = true;
    this._posDirty  = true;
  }

  /** Replace the edge list. Edges reference node IDs. */
  setEdges(edges: Array<{ source: number; target: number }>): void {
    this.edges = edges;
    this._edgeDirty = true;
  }

  /**
   * Called every physics frame with the latest positions.
   * positions: Float32Array [x0, y0, x1, y1, …] length = nodeCount * 2.
   * nodeIds accompanies positions (same order).
   */
  updatePositions(positions: Float32Array, nodeIds: Int32Array): void {
    this.positions = positions;
    // Rebuild the index map in case topology changed (nodeIds re-sent on init/setTopology)
    if (nodeIds.length !== this.nodeIdOrder.length) {
      this.nodeIndex.clear();
      this.nodeIdOrder = new Int32Array(nodeIds);
      for (let i = 0; i < nodeIds.length; i++) {
        this.nodeIndex.set(nodeIds[i], i);
      }
      // Node order changed — re-resolve edge indices
      this._edgeDirty = true;
    }
    this._posDirty = true;
  }

  /** Override a single node's position (e.g., during drag on main thread). */
  overridePosition(nodeId: number, x: number, y: number): void {
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

  /** Signal the renderer which node is currently hovered (for ring highlight). */
  setHoveredNode(id: number): void {
    this._hoveredNodeId = id;
  }

  /** Signal the renderer which node is currently selected (for ring highlight). */
  setSelectedNode(id: number): void {
    this._selectedNodeId = id;
  }

  /** Read-only access to the latest physics positions (for label rendering). */
  get nodePositions(): Float32Array { return this.positions; }
  /** Read-only ordered list of node IDs (index matches nodePositions). */
  get nodeOrder(): Int32Array { return this.nodeIdOrder; }

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

    // No CPU culling — GPU clip space discards off-screen quads for free.
    for (let i = 0; i < n; i++) {
      const id     = this.nodeIdOrder[i];
      const vis    = this.nodeVisuals.get(id);
      const radius = vis?.radius ?? this.opts.defaultRadius;
      const color  = vis?.color;
      const def    = color ? null : defaultColor;

      const base = i * NODE_STRIDE;
      this.nodeInstData[base    ] = pos[i * 2];
      this.nodeInstData[base + 1] = pos[i * 2 + 1];
      this.nodeInstData[base + 2] = radius;
      this.nodeInstData[base + 3] = color ? color[0] : def![0];
      this.nodeInstData[base + 4] = color ? color[1] : def![1];
      this.nodeInstData[base + 5] = color ? color[2] : def![2];
      this.nodeInstData[base + 6] = color ? color[3] : def![3];
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

    const [er, eg, eb, ea] = getCssEdgeColor();
    const width = this.opts.edgeWidth;

    let count = 0;
    for (let i = 0; i < ne; i++) {
      const { source, target } = edges[i];
      const si = this.nodeIndex.get(source);
      const ti = this.nodeIndex.get(target);
      if (si === undefined || ti === undefined) continue;

      // Store indices as floats — shader casts to int via int()
      const base = count * EDGE_STRIDE;
      this.edgeInstData[base    ] = si;   // source node index
      this.edgeInstData[base + 1] = ti;   // target node index
      this.edgeInstData[base + 2] = width;
      this.edgeInstData[base + 3] = er;
      this.edgeInstData[base + 4] = eg;
      this.edgeInstData[base + 5] = eb;
      this.edgeInstData[base + 6] = ea;
      count++;
    }

    this.edgeInstCount = count;

    const gl = this.gl!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeInstBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.edgeInstData, 0, count * EDGE_STRIDE);
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

    // ── Position update (O(N), every physics frame) ──
    // Upload positions texture + repack node instances.
    // Camera movement does NOT reach this path — camera is just a uniform.
    if (this._posDirty) {
      this._posDirty = false;
      this._uploadPositionTexture(); // zero-copy: positions buffer IS the texture data
      this._packNodeInstances();     // O(N): positions + radii + colors per node
    }

    gl.clear(gl.COLOR_BUFFER_BIT);

    const { x: cx, y: cy, zoom } = this.camera;
    this._resBuf[0] = this.canvasW;
    this._resBuf[1] = this.canvasH;
    this._camBuf[0] = cx;
    this._camBuf[1] = cy;

    // ── Draw edges (GPU samples positions from texture — O(1) CPU per frame) ──
    if (this.edgeInstCount > 0 && this.posTex) {
      gl.useProgram(this.edgeProg);
      gl.bindVertexArray(this.edgeVAO);
      gl.uniform2fv(this.edgeUniforms.resolution, this._resBuf);
      gl.uniform2fv(this.edgeUniforms.camera, this._camBuf);
      gl.uniform1f( this.edgeUniforms.zoom, zoom);
      // Bind position texture to unit 0 for the edge shader
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.posTex);
      gl.uniform1i(this.edgeUniforms.positions, 0);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.edgeInstCount);
    }

    // ── Draw nodes ────────────────────────────────────────────
    if (this.nodeInstCount > 0) {
      gl.useProgram(this.nodeProg);
      gl.bindVertexArray(this.nodeVAO);
      gl.uniform2fv(this.nodeUniforms.resolution, this._resBuf);
      gl.uniform2fv(this.nodeUniforms.camera, this._camBuf);
      gl.uniform1f( this.nodeUniforms.zoom, zoom);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.nodeInstCount);
    }

    // ── Draw hover / selection rings (on top of nodes) ────────
    this.ringInstCount = 0;
    const rid = this.ringInstData;

    // Helper: write one ring instance into ringInstData at offset `base`.
    // Hover ring: faint, off-white.  Selected ring: bright accent.
    const writeRing = (nodeId: number, scale: number, r: number, g: number, b: number, a: number): void => {
      const idx = this.nodeIndex.get(nodeId);
      if (idx === undefined) return;
      const px  = this.positions[idx * 2];
      const py  = this.positions[idx * 2 + 1];
      const vis = this.nodeVisuals.get(nodeId);
      const baseRadius = vis?.radius ?? this.opts.defaultRadius;
      const base = this.ringInstCount * NODE_STRIDE;
      rid[base    ] = px;
      rid[base + 1] = py;
      rid[base + 2] = baseRadius * scale;
      rid[base + 3] = r;
      rid[base + 4] = g;
      rid[base + 5] = b;
      rid[base + 6] = a;
      this.ringInstCount++;
    };

    if (this._selectedNodeId >= 0) writeRing(this._selectedNodeId, 1.85, 0.42, 0.72, 1.0, 0.85);
    if (this._hoveredNodeId >= 0 && this._hoveredNodeId !== this._selectedNodeId) {
      writeRing(this._hoveredNodeId, 1.85, 1.0, 1.0, 1.0, 0.35);
    }

    if (this.ringInstCount > 0 && this.ringVAO) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.ringInstBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, rid, 0, this.ringInstCount * NODE_STRIDE);
      gl.useProgram(this.ringProg);
      gl.bindVertexArray(this.ringVAO);
      gl.uniform2fv(this.ringUniforms.resolution, this._resBuf);
      gl.uniform2fv(this.ringUniforms.camera, this._camBuf);
      gl.uniform1f( this.ringUniforms.zoom, zoom);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.ringInstCount);
    }

    gl.bindVertexArray(null);
  }

  // ─── Diagnostics ───────────────────────────────────────────────────────────

  get stats() {
    return {
      nodeInstCount: this.nodeInstCount,
      edgeInstCount: this.edgeInstCount,
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

  /** Find the closest node to a world-space point within maxDist world units. */
  pickNode(wx: number, wy: number, maxDist = 20): number | null {
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
}
