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

// Edge vertex: expand a unit quad [-0.5..0.5, 0..1] along the edge direction.
// a_local.x = side (-0.5 or +0.5), a_local.y = t (0 or 1, start vs end)
const EDGE_VERT_SRC = /* glsl */ `#version 300 es
precision highp float;

// Per-vertex (local edge-quad coords)
in vec2 a_local; // x = side (-0.5..0.5), y = t (0..1)

// Per-instance
in vec2  a_p1;    // world-space start
in vec2  a_p2;    // world-space end
in float a_width; // world-space half-width
in vec4  a_color; // RGBA 0..1

// Camera
uniform vec2  u_resolution;
uniform vec2  u_camera;
uniform float u_zoom;

out vec4 v_color;

void main() {
  v_color = a_color;

  vec2 dir  = a_p2 - a_p1;
  float len = length(dir);
  vec2 perp = (len > 0.001)
    ? vec2(-dir.y, dir.x) / len
    : vec2(0.0, 1.0);

  // world-space position of this quad vertex
  vec2 base  = mix(a_p1, a_p2, a_local.y);
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
const NODE_STRIDE  = 7; // x, y, radius, r, g, b, a
// Floats per edge instance
const EDGE_STRIDE  = 9; // x1, y1, x2, y2, width, r, g, b, a

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

  // --- Node VAO / buffers ---
  private nodeVAO: WebGLVertexArrayObject | null = null;
  private nodeQuadBuf: WebGLBuffer | null = null;   // static geometry
  private nodeInstBuf: WebGLBuffer | null = null;   // dynamic instances
  private nodeInstCapacity = 0;                      // allocated floats
  private nodeInstData: Float32Array = new Float32Array(0);
  private nodeInstCount = 0;

  // --- Edge VAO / buffers ---
  private edgeVAO: WebGLVertexArrayObject | null = null;
  private edgeQuadBuf: WebGLBuffer | null = null;
  private edgeInstBuf: WebGLBuffer | null = null;
  private edgeInstCapacity = 0;
  private edgeInstData: Float32Array = new Float32Array(0);
  private edgeInstCount = 0;

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
  private nodeUniforms: { resolution: WebGLUniformLocation | null; camera: WebGLUniformLocation | null; zoom: WebGLUniformLocation | null } = { resolution: null, camera: null, zoom: null };
  private edgeUniforms: { resolution: WebGLUniformLocation | null; camera: WebGLUniformLocation | null; zoom: WebGLUniformLocation | null } = { resolution: null, camera: null, zoom: null };

  // --- Pre-allocated typed arrays for uniforms (zero per-frame GC) ---
  private readonly _resBuf = new Float32Array(2);
  private readonly _camBuf = new Float32Array(2);

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
    };

    this._initNodeBuffers();
    this._initEdgeBuffers();
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
    gl.deleteBuffer(this.nodeQuadBuf);
    gl.deleteBuffer(this.nodeInstBuf);
    gl.deleteBuffer(this.edgeQuadBuf);
    gl.deleteBuffer(this.edgeInstBuf);
    gl.deleteVertexArray(this.nodeVAO);
    gl.deleteVertexArray(this.edgeVAO);

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

    // Dynamic instance buffer
    this.edgeInstCapacity = this.opts.initialCapacity * EDGE_STRIDE;
    this.edgeInstData     = new Float32Array(this.edgeInstCapacity);
    this.edgeInstBuf      = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeInstBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.edgeInstData, gl.DYNAMIC_DRAW);

    const STRIDE  = EDGE_STRIDE * 4;
    const aP1     = gl.getAttribLocation(this.edgeProg!, 'a_p1');
    const aP2     = gl.getAttribLocation(this.edgeProg!, 'a_p2');
    const aWidth  = gl.getAttribLocation(this.edgeProg!, 'a_width');
    const aColor  = gl.getAttribLocation(this.edgeProg!, 'a_color');

    gl.enableVertexAttribArray(aP1);
    gl.vertexAttribPointer(aP1, 2, gl.FLOAT, false, STRIDE, 0);
    gl.vertexAttribDivisor(aP1, 1);

    gl.enableVertexAttribArray(aP2);
    gl.vertexAttribPointer(aP2, 2, gl.FLOAT, false, STRIDE, 8);
    gl.vertexAttribDivisor(aP2, 1);

    gl.enableVertexAttribArray(aWidth);
    gl.vertexAttribPointer(aWidth, 1, gl.FLOAT, false, STRIDE, 16);
    gl.vertexAttribDivisor(aWidth, 1);

    gl.enableVertexAttribArray(aColor);
    gl.vertexAttribPointer(aColor, 4, gl.FLOAT, false, STRIDE, 20);
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
  }

  /** Replace the edge list. Edges reference node IDs. */
  setEdges(edges: Array<{ source: number; target: number }>): void {
    this.edges = edges;
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
    }
    this._packNodeInstances();
    this._packEdgeInstances();
  }

  /** Override a single node's position (e.g., during drag on main thread). */
  overridePosition(nodeId: number, x: number, y: number): void {
    const idx = this.nodeIndex.get(nodeId);
    if (idx === undefined) return;
    if (this.positions.length >= (idx + 1) * 2) {
      this.positions[idx * 2]     = x;
      this.positions[idx * 2 + 1] = y;
    }
  }

  // ─── Camera ────────────────────────────────────────────────────────────────

  setCamera(x: number, y: number, zoom: number): void {
    this.camera = { x, y, zoom };
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

    const { x: cx, y: cy, zoom } = this.camera;
    const cullM = this.opts.cullMargin;
    const halfW = this.canvasW * 0.5;
    const halfH = this.canvasH * 0.5;

    const pos = this.positions;
    let count = 0;

    for (let i = 0; i < n; i++) {
      const id  = this.nodeIdOrder[i];
      const px  = pos[i * 2];
      const py  = pos[i * 2 + 1];

      // CPU-side culling (world → screen)
      if (cullM > 0) {
        const sx  = (px - cx) * zoom;
        const sy  = (py - cy) * zoom;
        const vis = this.nodeVisuals.get(id);
        const r   = (vis?.radius ?? this.opts.defaultRadius) * zoom;
        if (
          sx + r < -halfW - cullM ||
          sx - r >  halfW + cullM ||
          sy + r < -halfH - cullM ||
          sy - r >  halfH + cullM
        ) continue;
      }

      const vis    = this.nodeVisuals.get(id);
      const radius = vis?.radius ?? this.opts.defaultRadius;
      const color  = vis?.color;
      const def    = color ? null : getCssNodeDefaultColor();

      const base = count * NODE_STRIDE;
      this.nodeInstData[base    ] = px;
      this.nodeInstData[base + 1] = py;
      this.nodeInstData[base + 2] = radius;
      this.nodeInstData[base + 3] = color ? color[0] : def![0];
      this.nodeInstData[base + 4] = color ? color[1] : def![1];
      this.nodeInstData[base + 5] = color ? color[2] : def![2];
      this.nodeInstData[base + 6] = color ? color[3] : def![3];
      count++;
    }

    this.nodeInstCount = count;

    const gl = this.gl!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeInstBuf);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.nodeInstData,
      0,
      count * NODE_STRIDE,
    );
  }

  private _packEdgeInstances(): void {
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

    const { x: cx, y: cy, zoom } = this.camera;
    const cullM = this.opts.cullMargin;
    const halfW = this.canvasW * 0.5;
    const halfH = this.canvasH * 0.5;

    const [er, eg, eb, ea] = getCssEdgeColor();
    const width = this.opts.edgeWidth;
    const pos   = this.positions;

    let count = 0;

    for (let i = 0; i < ne; i++) {
      const { source, target } = edges[i];
      const si = this.nodeIndex.get(source);
      const ti = this.nodeIndex.get(target);
      if (si === undefined || ti === undefined) continue;

      const x1 = pos[si * 2];
      const y1 = pos[si * 2 + 1];
      const x2 = pos[ti * 2];
      const y2 = pos[ti * 2 + 1];

      // Cull edges: skip if both endpoints are offscreen
      if (cullM > 0) {
        const s1x = (x1 - cx) * zoom, s1y = (y1 - cy) * zoom;
        const s2x = (x2 - cx) * zoom, s2y = (y2 - cy) * zoom;
        const minX = Math.min(s1x, s2x), maxX = Math.max(s1x, s2x);
        const minY = Math.min(s1y, s2y), maxY = Math.max(s1y, s2y);
        if (
          maxX < -halfW - cullM || minX > halfW + cullM ||
          maxY < -halfH - cullM || minY > halfH + cullM
        ) continue;
      }

      const base = count * EDGE_STRIDE;
      this.edgeInstData[base    ] = x1;
      this.edgeInstData[base + 1] = y1;
      this.edgeInstData[base + 2] = x2;
      this.edgeInstData[base + 3] = y2;
      this.edgeInstData[base + 4] = width;
      this.edgeInstData[base + 5] = er;
      this.edgeInstData[base + 6] = eg;
      this.edgeInstData[base + 7] = eb;
      this.edgeInstData[base + 8] = ea;
      count++;
    }

    this.edgeInstCount = count;

    const gl = this.gl!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeInstBuf);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.edgeInstData,
      0,
      count * EDGE_STRIDE,
    );
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  /** Draw one frame. Call from requestAnimationFrame callback. */
  render(): void {
    const gl = this.gl;
    if (!gl) return;

    gl.clear(gl.COLOR_BUFFER_BIT);

    const { x: cx, y: cy, zoom } = this.camera;

    // Reuse pre-allocated typed arrays — zero per-frame allocation
    this._resBuf[0] = this.canvasW;
    this._resBuf[1] = this.canvasH;
    this._camBuf[0] = cx;
    this._camBuf[1] = cy;

    // ── Draw edges ────────────────────────────────────────────
    if (this.edgeInstCount > 0) {
      gl.useProgram(this.edgeProg);
      gl.bindVertexArray(this.edgeVAO);
      gl.uniform2fv(this.edgeUniforms.resolution, this._resBuf);
      gl.uniform2fv(this.edgeUniforms.camera, this._camBuf);
      gl.uniform1f( this.edgeUniforms.zoom, zoom);
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
