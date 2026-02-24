/**
 * TerrainWebGLRenderer
 *
 * GPU-accelerated terrain contour renderer using a fullscreen-quad approach.
 *
 * Strategy
 * ────────
 * Rather than running marching-squares on the CPU and uploading line segments,
 * this renderer uploads the raw height-map as an R32F texture and runs a
 * screen-space contour shader in the fragment stage.
 *
 * Per-fragment process:
 *  1. Convert fragment screen position → world position (pan/zoom uniforms).
 *  2. Look up h = heightMap(worldPos) via bilinear texture sample.
 *  3. Compute ∇h in screen pixels via central finite differences on the texture.
 *  4. For each contour level l:  dist_px = |h − l| / |∇h|  (exact iso-distance).
 *  5. Anti-alias with smoothstep on the nearest-level distance.
 *  6. Colorize from the ownership-color RGBA texture (bilinear blend = free blur).
 *  7. Apply selection dimming via a separate R8 mask texture.
 *
 * Benefits over CPU marching-squares:
 *  • Zero-resolution-limit — contours are pixel-perfect at any zoom level.
 *  • No chain-building, chain-stitching, Ramer-Douglas-Peucker, or Canvas 2D
 *    offscreen compositing passes needed on the CPU.
 *  • Selection masking is a free bilinear texture lookup in the shader.
 *  • Theme changes only require re-setting two uniforms (no rebuild).
 *  • Reference-path A* result is forwarded unchanged; only its *rendering*
 *    moves to the Canvas2D overlay.
 */

import { CONTOUR_LEVELS } from './viewTypes';

// ─── GLSL Shaders ─────────────────────────────────────────────────────────────

const VERT_SRC = /* glsl */ `#version 300 es
precision highp float;

// Unit fullscreen quad [-1, 1]
in vec2 a_pos;

// Pass screen-space UV (0..1) to fragment shader
out vec2 v_screenUV;

void main() {
  v_screenUV  = a_pos * 0.5 + 0.5;     // [-1,1] → [0,1]
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

// Maximum number of contour levels (must match JS MAX_LEVELS constant below)
const MAX_LEVELS = 24;

const FRAG_SRC = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

// ── Screen / camera ──────────────────────────────────────────────────────────
uniform vec2  u_resolution;     // canvas size in pixels (backed buffer, not CSS)
uniform vec2  u_camTranslate;   // screen-pixel offset of world origin (pan)
uniform float u_camScale;       // pixels per world unit (zoom)

// ── Grid / texture ───────────────────────────────────────────────────────────
uniform sampler2D u_heightMap;  // R32F  — raw normalised height [0,1]
uniform sampler2D u_colorMap;   // RGBA8 — ownership colour  (bilinear blur free)
uniform sampler2D u_selMask;    // R8    — selection weight [0,1] (bilinear)
uniform vec2  u_worldOrigin;    // world-space bottom-left of the height grid
uniform vec2  u_gridDims;       // (gridW, gridH) in texels
uniform float u_gridSize;       // world units per texel

// ── Contour styling ──────────────────────────────────────────────────────────
uniform int   u_levelCount;
uniform float u_levels[${MAX_LEVELS}]; // normalised heights for each iso-line
uniform int   u_hoveredLevel;        // index of hovered level, -1 = none
uniform int   u_majorEvery;          // every Nth level is a major contour (e.g. 5)
uniform bool  u_hasSelection;
uniform bool  u_hasClassColors;
uniform vec3  u_lowColor;
uniform vec3  u_highColor;
uniform float u_baseAlphaScale;      // global opacity (1 = normal, <1 for fade)

in  vec2 v_screenUV;
out vec4 outColor;

// ─── Helpers ─────────────────────────────────────────────────────────────────

float sampleH(vec2 uv) {
  return texture(u_heightMap, uv).r;
}

void main() {
  // ── 1. Screen position → world position ────────────────────────────────────
  vec2 screenPos = v_screenUV * u_resolution;
  // screenPos = worldPos * camScale + camTranslate
  vec2 worldPos  = (screenPos - u_camTranslate) / u_camScale;

  // ── 2. World → height-map texture UV ───────────────────────────────────────
  // gridPos in grid cells:  gridCell = (worldPos - worldOrigin) / gridSize
  // texUV = gridCell / gridDims
  vec2 gridCell = (worldPos - u_worldOrigin) / u_gridSize;
  vec2 texUV    = gridCell / u_gridDims;

  // Discard pixels that fall outside the height-map extents
  if (texUV.x < 0.0 || texUV.x > 1.0 || texUV.y < 0.0 || texUV.y > 1.0) {
    discard;
  }

  // ── 3. Height + screen-space gradient ──────────────────────────────────────
  float h = sampleH(texUV);

  // Discard very low-altitude fragments (below lowest contour)
  if (h <= u_levels[0] * 0.5) discard;

  // Central finite differences in texture space
  vec2 dUV = 1.0 / u_gridDims; // one-texel step
  float hxTex = (sampleH(texUV + vec2(dUV.x, 0.0))
               - sampleH(texUV - vec2(dUV.x, 0.0))) * 0.5;
  float hyTex = (sampleH(texUV + vec2(0.0, dUV.y))
               - sampleH(texUV - vec2(0.0, dUV.y))) * 0.5;

  // Convert texture-space gradient to screen-pixels-per-height-unit:
  //   ∂h/∂x_world = hxTex / gridSize  (per world unit)
  //   ∂h/∂x_screen = ∂h/∂x_world * camScale  (per screen pixel)
  float gx = hxTex / u_gridSize * u_camScale;
  float gy = hyTex / u_gridSize * u_camScale;
  // gradLen: screen pixels of height change per screen pixel moved
  float gradLen = length(vec2(gx, gy));
  // Clamp to avoid ÷0 on perfectly flat areas
  gradLen = max(gradLen, 0.002);

  // ── 4. Find nearest contour level ─────────────────────────────────────────
  float minDist   = 1.0e6;
  float minLevel  = -1.0;
  bool  minMajor  = false;
  bool  minHover  = false;

  for (int i = 0; i < ${MAX_LEVELS}; i++) {
    if (i >= u_levelCount) break;
    float lv   = u_levels[i];
    float dist = abs(h - lv) / gradLen;  // screen-pixel distance to this iso-line
    if (dist < minDist) {
      minDist  = dist;
      minLevel = lv;
      minMajor = (mod(float(i + 1), float(u_majorEvery)) == 0.0);
      minHover = (u_hoveredLevel == i);
    }
  }

  // ── 5. Anti-aliased line strength ─────────────────────────────────────────
  // Line half-width in screen pixels
  float halfW = minHover ? 1.6 : minMajor ? 1.0 : 0.65;
  // smoothstep: full opacity inside, tapers off outside by 1 px
  float lineAlpha = smoothstep(halfW + 1.0, halfW - 0.5, minDist);
  if (lineAlpha < 0.005) discard;

  // ── 6. Contour opacity style ───────────────────────────────────────────────
  float baseOp = minHover ? 0.9 : 0.25 + minLevel * 0.5;

  // ── 7. Ownership colour via bilinear-filtered texture ─────────────────────
  vec4  ownerColor = texture(u_colorMap, texUV);   // RGBA8, bilinear = free blur
  float selWeight  = u_hasSelection
      ? texture(u_selMask, texUV).r
      : 1.0;

  // Selection dimming: non-selected areas drawn at DIM_OPACITY
  const float DIM_OPACITY = 0.22;
  float selFactor = u_hasSelection
      ? mix(DIM_OPACITY, 1.0, selWeight)
      : 1.0;

  // ── 8. Final colour ────────────────────────────────────────────────────────
  vec3 lineColor;
  if (u_hasClassColors) {
    // Contour lines tinted by ownership; whitened for readability
    lineColor = mix(ownerColor.rgb, vec3(1.0), 0.25);
  } else {
    // Smooth gradient from low-altitude colour to high-altitude colour
    lineColor = mix(u_lowColor, u_highColor, minLevel);
  }

  float finalAlpha = lineAlpha * baseOp * selFactor * u_baseAlphaScale;
  outColor = vec4(lineColor, finalAlpha);
}
`;

// ─── WebGL helpers ─────────────────────────────────────────────────────────────

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(`TerrainGL shader: ${gl.getShaderInfoLog(s)}`);
  }
  return s;
}

function linkProgram(
  gl: WebGL2RenderingContext,
  vs: string,
  fs: string,
): WebGLProgram {
  const v = compileShader(gl, gl.VERTEX_SHADER, vs);
  const f = compileShader(gl, gl.FRAGMENT_SHADER, fs);
  const p = gl.createProgram()!;
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`TerrainGL link: ${gl.getProgramInfoLog(p)}`);
  }
  gl.deleteShader(v);
  gl.deleteShader(f);
  return p;
}

function ensureTexture(
  gl: WebGL2RenderingContext,
  existing: WebGLTexture | null,
): WebGLTexture {
  return existing ?? gl.createTexture()!;
}

// ─── CSS colour helpers ─────────────────────────────────────────────────────────

function hexToRGB(hex: string): [number, number, number] {
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
  return [r / 255, g / 255, b / 255];
}

// ─── Uniform cache ─────────────────────────────────────────────────────────────

interface UniformLocs {
  resolution:     WebGLUniformLocation | null;
  camTranslate:   WebGLUniformLocation | null;
  camScale:       WebGLUniformLocation | null;
  heightMap:      WebGLUniformLocation | null;
  colorMap:       WebGLUniformLocation | null;
  selMask:        WebGLUniformLocation | null;
  worldOrigin:    WebGLUniformLocation | null;
  gridDims:       WebGLUniformLocation | null;
  gridSize:       WebGLUniformLocation | null;
  levelCount:     WebGLUniformLocation | null;
  levels:         WebGLUniformLocation | null;
  hoveredLevel:   WebGLUniformLocation | null;
  majorEvery:     WebGLUniformLocation | null;
  hasSelection:   WebGLUniformLocation | null;
  hasClassColors: WebGLUniformLocation | null;
  lowColor:       WebGLUniformLocation | null;
  highColor:      WebGLUniformLocation | null;
  baseAlphaScale: WebGLUniformLocation | null;
}

// ─── Public API ─────────────────────────────────────────────────────────────────

export interface TerrainCameraState {
  /** Screen-pixel translation of the world origin (pan x, y). */
  translateX: number;
  translateY: number;
  /** Pixels per world unit (zoom). */
  scale: number;
}

export interface TerrainContourStyle {
  /** Index into CONTOUR_LEVELS that is currently hovered (from height-map hit-test). -1 = none. */
  hoveredLevelIndex: number;
  /** True when node class colours should tint contour lines. */
  hasClassColors: boolean;
  /** True when a selection is active — enables dim/bright compositing. */
  hasSelection: boolean;
  /** CSS hex colour for low-altitude contours (e.g. --color-outline). */
  lowColor: string;
  /** CSS hex colour for high-altitude contours (e.g. --color-accent). */
  highColor: string;
  /** Global opacity multiplier [0,1]. Use for fade animations. Default 1. */
  alphaScale?: number;
}

// ─── Main class ─────────────────────────────────────────────────────────────────

export class TerrainWebGLRenderer {
  private gl: WebGL2RenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private quadVAO: WebGLVertexArrayObject | null = null;
  private quadBuf: WebGLBuffer | null = null;

  // GPU textures
  private heightTex: WebGLTexture | null = null;   // R32F   — height map
  private colorTex: WebGLTexture | null = null;    // RGBA8  — ownership colour
  private selTex: WebGLTexture | null = null;      // R8     — selection mask

  // Current texture dimensions (for invalidation)
  private texW = 0;
  private texH = 0;

  // Uniform locations (cached after link)
  private u: UniformLocs = {} as UniformLocs;

  // Canvas state
  private canvasW = 1;
  private canvasH = 1;

  // Pre-allocated uniform arrays (zero per-frame GC)
  private _resBuf   = new Float32Array(2);
  private _camTrans = new Float32Array(2);
  private _origBuf  = new Float32Array(2);
  private _dimsBuf  = new Float32Array(2);
  private _levBuf   = new Float32Array(MAX_LEVELS);

  // Track whether grid data has been uploaded at least once
  private _hasData = false;

  // Fullscreen quad vertices (NDC, two triangles)
  private static readonly QUAD = new Float32Array([
    -1, -1,   1, -1,   1,  1,
    -1, -1,   1,  1,  -1,  1,
  ]);

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Attach to a canvas element and initialise WebGL2.
   * Throws if WebGL2 is unavailable.
   */
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

    this.prog = linkProgram(gl, VERT_SRC, FRAG_SRC);

    // Cache all uniform locations once after linking
    const p = this.prog;
    this.u = {
      resolution:     gl.getUniformLocation(p, 'u_resolution'),
      camTranslate:   gl.getUniformLocation(p, 'u_camTranslate'),
      camScale:       gl.getUniformLocation(p, 'u_camScale'),
      heightMap:      gl.getUniformLocation(p, 'u_heightMap'),
      colorMap:       gl.getUniformLocation(p, 'u_colorMap'),
      selMask:        gl.getUniformLocation(p, 'u_selMask'),
      worldOrigin:    gl.getUniformLocation(p, 'u_worldOrigin'),
      gridDims:       gl.getUniformLocation(p, 'u_gridDims'),
      gridSize:       gl.getUniformLocation(p, 'u_gridSize'),
      levelCount:     gl.getUniformLocation(p, 'u_levelCount'),
      levels:         gl.getUniformLocation(p, 'u_levels[0]'),
      hoveredLevel:   gl.getUniformLocation(p, 'u_hoveredLevel'),
      majorEvery:     gl.getUniformLocation(p, 'u_majorEvery'),
      hasSelection:   gl.getUniformLocation(p, 'u_hasSelection'),
      hasClassColors: gl.getUniformLocation(p, 'u_hasClassColors'),
      lowColor:       gl.getUniformLocation(p, 'u_lowColor'),
      highColor:      gl.getUniformLocation(p, 'u_highColor'),
      baseAlphaScale: gl.getUniformLocation(p, 'u_baseAlphaScale'),
    };

    // Upload contour levels once (they only change if the viewTypes constant changes)
    gl.useProgram(this.prog);
    const nLvl = Math.min(CONTOUR_LEVELS.length, MAX_LEVELS);
    for (let i = 0; i < nLvl; i++) this._levBuf[i] = CONTOUR_LEVELS[i];
    gl.uniform1i(this.u.levelCount, nLvl);
    gl.uniform1fv(this.u.levels, this._levBuf);
    // Major contour every 5th level (matching the existing Canvas 2D rule: (li+1) % 5 === 0)
    gl.uniform1i(this.u.majorEvery, 5);
    gl.useProgram(null);

    this._initQuad();

    this.canvasW = canvas.width;
    this.canvasH = canvas.height;
    gl.viewport(0, 0, this.canvasW, this.canvasH);
  }

  /** Release all GPU resources. */
  destroy(): void {
    const gl = this.gl;
    if (!gl) return;
    gl.deleteProgram(this.prog);
    gl.deleteVertexArray(this.quadVAO);
    gl.deleteBuffer(this.quadBuf);
    gl.deleteTexture(this.heightTex);
    gl.deleteTexture(this.colorTex);
    gl.deleteTexture(this.selTex);
    this.gl = null;
  }

  // ─── Resize ────────────────────────────────────────────────────────────────

  resize(w: number, h: number): void {
    const gl = this.gl;
    if (!gl) return;
    this.canvasW = w;
    this.canvasH = h;
    gl.viewport(0, 0, w, h);
  }

  // ─── Camera ────────────────────────────────────────────────────────────────

  /** Update camera from the terrain Transform (pan x/y in screen pixels, scale = px/world-unit). */
  setCamera(cam: TerrainCameraState): void {
    this._camTrans[0] = cam.translateX;
    this._camTrans[1] = cam.translateY;
    // camScale stored as a scalar — set in render()
    this._camScaleVal = cam.scale;
  }
  private _camScaleVal = 1;

  // ─── Data uploads ──────────────────────────────────────────────────────────

  /**
   * Upload the normalised height map [0,1] as a float texture.
   * Also records world-space geometry (origin + cell size) used by the shader.
   *
   * @param data      CPU Float32Array, row-major (row 0 = top of grid in world Y).
   * @param gridW     Number of columns.
   * @param gridH     Number of rows.
   * @param originX   World X coordinate of the left edge of the grid.
   * @param originY   World Y coordinate of the top edge of the grid.
   * @param gridSize  World units per grid cell (same for X and Y).
   */
  uploadHeightMap(
    data: Float32Array,
    gridW: number,
    gridH: number,
    originX: number,
    originY: number,
    gridSize: number,
  ): void {
    const gl = this.gl;
    if (!gl) return;

    this.heightTex = ensureTexture(gl, this.heightTex);
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);

    // Allocate or re-allocate the texture if dimensions changed
    if (gridW !== this.texW || gridH !== this.texH) {
      gl.texImage2D(
        gl.TEXTURE_2D, 0,
        gl.R32F,          // internal format: 32-bit float single channel
        gridW, gridH, 0,
        gl.RED, gl.FLOAT, // source format
        data,
      );
      // Nearest filtering — we use the gradient for AA, not texture filtering
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else {
      // Same size — cheaper sub-image update
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0,
        0, 0, gridW, gridH,
        gl.RED, gl.FLOAT,
        data,
      );
    }

    gl.bindTexture(gl.TEXTURE_2D, null);

    // Store world-geometry for uniforms (set during render)
    this._texW       = gridW;
    this._texH       = gridH;
    this._originX    = originX;
    this._originY    = originY;
    this._gridSize   = gridSize;
    this._hasData    = true;
  }

  // Internal world-geometry (set alongside uploadHeightMap)
  private _texW = 0;
  private _texH = 0;
  private _originX = 0;
  private _originY = 0;
  private _gridSize = 4;

  /**
   * Upload an RGBA ownership colour texture at the same grid resolution.
   * Each pixel encodes the RGB colour of the node that owns that grid cell
   * (or the fallback low-altitude colour for unowned cells).
   *
   * Bilinear filtering is intentionally enabled — this gives a smooth gradient
   * "blend" between adjacent ownership regions for free, replacing the
   * offscreen-canvas upscale blur used by the old Canvas 2D renderer.
   *
   * @param ownerMap    Int32Array of owner node indices (-1 = unowned).
   * @param gridW       Grid width.
   * @param gridH       Grid height.
   * @param nodeRGB     Array of [r,g,b] per visible node (0–255 each per element).
   * @param fallbackRGB Fallback colour for unowned / below-sea-level cells.
   */
  uploadOwnershipColors(
    ownerMap: Int32Array,
    gridW: number,
    gridH: number,
    nodeRGB: Array<[number, number, number]>,
    fallbackRGB: [number, number, number],
  ): void {
    const gl = this.gl;
    if (!gl) return;

    const n = gridW * gridH;
    // Reuse the scratch buffer (allocated lazily)
    if (!this._colorBuf || this._colorBuf.length < n * 4) {
      this._colorBuf = new Uint8Array(n * 4);
    }
    const buf = this._colorBuf;

    const [fr, fg, fb] = fallbackRGB;
    for (let i = 0; i < n; i++) {
      const owner = ownerMap[i];
      const off = i * 4;
      if (owner >= 0 && owner < nodeRGB.length) {
        const [cr, cg, cb] = nodeRGB[owner];
        buf[off]   = cr;
        buf[off+1] = cg;
        buf[off+2] = cb;
      } else {
        buf[off]   = fr;
        buf[off+1] = fg;
        buf[off+2] = fb;
      }
      buf[off+3] = 255;
    }

    this.colorTex = ensureTexture(gl, this.colorTex);
    gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0,
      gl.RGBA, gridW, gridH, 0,
      gl.RGBA, gl.UNSIGNED_BYTE,
      buf,
    );
    // LINEAR filtering replaces the bilinear-upscale blur in the old renderer
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  private _colorBuf: Uint8Array | null = null;

  /**
   * Upload a single-channel selection mask.
   * 255 = fully selected ownership, 0 = not selected.
   * LINEAR filtering gives a smooth gradient at selection region boundaries.
   *
   * @param ownerMap         Int32Array, same as passed to uploadOwnershipColors.
   * @param gridW / gridH    Grid dimensions.
   * @param selectedSet      Set of owner node indices that are currently selected.
   */
  uploadSelectionMask(
    ownerMap: Int32Array,
    gridW: number,
    gridH: number,
    selectedSet: Set<number>,
  ): void {
    const gl = this.gl;
    if (!gl) return;

    const n = gridW * gridH;
    if (!this._selBuf || this._selBuf.length < n) {
      this._selBuf = new Uint8Array(n);
    }
    const buf = this._selBuf;
    for (let i = 0; i < n; i++) {
      buf[i] = (selectedSet.has(ownerMap[i])) ? 255 : 0;
    }

    this.selTex = ensureTexture(gl, this.selTex);
    gl.bindTexture(gl.TEXTURE_2D, this.selTex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0,
      gl.R8, gridW, gridH, 0,
      gl.RED, gl.UNSIGNED_BYTE,
      buf,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  private _selBuf: Uint8Array | null = null;

  // ─── Contour style ─────────────────────────────────────────────────────────

  private _style: TerrainContourStyle = {
    hoveredLevelIndex: -1,
    hasClassColors:    false,
    hasSelection:      false,
    lowColor:          '#a3a3a3',
    highColor:         '#404040',
    alphaScale:        1,
  };

  setContourStyle(style: TerrainContourStyle): void {
    this._style = style;
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  /**
   * Draw one frame.  Call every RAF tick (or after every physics frame).
   * Returns immediately if no height-map has been uploaded yet.
   */
  render(): void {
    const gl = this.gl;
    if (!gl || !this._hasData) return;

    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.prog);
    gl.bindVertexArray(this.quadVAO);

    // ── Resolution ────────────────────────────────────────────────────────────
    this._resBuf[0] = this.canvasW;
    this._resBuf[1] = this.canvasH;
    gl.uniform2fv(this.u.resolution, this._resBuf);

    // ── Camera ────────────────────────────────────────────────────────────────
    gl.uniform2fv(this.u.camTranslate, this._camTrans);
    gl.uniform1f (this.u.camScale,     this._camScaleVal);

    // ── Grid geometry ─────────────────────────────────────────────────────────
    this._origBuf[0] = this._originX;
    this._origBuf[1] = this._originY;
    gl.uniform2fv(this.u.worldOrigin, this._origBuf);

    this._dimsBuf[0] = this._texW;
    this._dimsBuf[1] = this._texH;
    gl.uniform2fv(this.u.gridDims, this._dimsBuf);
    gl.uniform1f (this.u.gridSize, this._gridSize);

    // ── Textures (bind to fixed slots) ────────────────────────────────────────
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.uniform1i(this.u.heightMap, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
    gl.uniform1i(this.u.colorMap, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.selTex);
    gl.uniform1i(this.u.selMask, 2);

    // ── Contour style uniforms ────────────────────────────────────────────────
    const style = this._style;
    gl.uniform1i(this.u.hoveredLevel,   style.hoveredLevelIndex);
    gl.uniform1i(this.u.hasSelection,   style.hasSelection   ? 1 : 0);
    gl.uniform1i(this.u.hasClassColors, style.hasClassColors ? 1 : 0);
    gl.uniform1f(this.u.baseAlphaScale, style.alphaScale ?? 1);

    const [lr, lg, lb] = hexToRGB(style.lowColor);
    const [hr, hg, hb] = hexToRGB(style.highColor);
    gl.uniform3f(this.u.lowColor,  lr, lg, lb);
    gl.uniform3f(this.u.highColor, hr, hg, hb);

    // ── Draw fullscreen quad (2 triangles = 6 vertices) ───────────────────────
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.bindVertexArray(null);
    gl.useProgram(null);
  }

  // ─── Hit test ──────────────────────────────────────────────────────────────

  /**
   * Returns the CONTOUR_LEVELS index of the contour band containing the given
   * world position, or -1 if the position is outside the grid or below terrain.
   * Used by TerrainRenderer to highlight the hovered contour band.
   *
   * @param heightMap  The CPU-side Float32Array (same data uploaded to GPU).
   * @param h          Height value at the query point (caller should sample from heightMap).
   */
  static hoveredLevelIndex(h: number): number {
    for (let i = CONTOUR_LEVELS.length - 1; i >= 0; i--) {
      if (CONTOUR_LEVELS[i] <= h) return i;
    }
    return -1;
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private _initQuad(): void {
    const gl = this.gl!;

    this.quadVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVAO);

    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, TerrainWebGLRenderer.QUAD, gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(this.prog!, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);
  }
}
