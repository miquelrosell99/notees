/**
 * Terrain Reference Paths
 *
 * Computes least-slope paths between reference-linked node peaks on the terrain
 * height map using A* pathfinding on a downsampled grid. Paths start and end at
 * the edge of each peak's plateau (not the center), following a natural
 * downhill → valley → uphill trajectory.
 *
 * Also applies subtle erosion along computed paths to create shallow valleys.
 *
 * This module does NOT affect node positions or physics — paths are purely
 * derived geometry rendered after contour lines.
 */

// ==================== Types ====================

export interface ReferencePath {
  /** Source node id */
  sourceId: number;
  /** Target node id */
  targetId: number;
  /** Path points in screen coordinates (px) */
  screenPoints: Array<[number, number]>;
  /** Average slope along the path (for line-width variation) */
  avgSlope: number;
}

export interface ReferencePathResult {
  paths: ReferencePath[];
}

/** Reference link extracted from visible links */
export interface RefLink {
  source: number;
  target: number;
}

/** Node peak info for path edge offset computation */
export interface NodePeakInfo {
  screenX: number;
  screenY: number;
  /** Plateau radius in screen pixels */
  plateauRadius: number;
}

// ==================== Constants ====================

/** Downsample factor for A* grid (relative to heightMap grid) */
const PATHFIND_DOWNSAMPLE = 2;

/**
 * A* cost weights — tuned for downhill→valley→uphill traversal.
 *
 * ALPHA: penalizes elevation change² (keeps path smooth, avoids cliffs)
 * BETA:  penalizes absolute height at each cell (drives path into valleys)
 * GAMMA: penalizes distance (keeps path reasonably short)
 */
const ALPHA = 6.0;   // elevation change² penalty
const BETA = 12.0;   // absolute height penalty — key for valley-seeking
const GAMMA = 1.0;   // distance penalty

/** Max path distance in grid cells before falling back to Bézier */
const MAX_ASTAR_GRID_DIST = 300;

/** Min distance in grid cells — skip A* for very close peaks */
const MIN_ASTAR_GRID_DIST = 3;

/** Erosion radius in grid cells around path */
const EROSION_RADIUS = 2;

/** Erosion multiplier per path (accumulated) */
const EROSION_FACTOR = 0.985;

/** Minimum height after erosion (prevent pits) */
const EROSION_MIN_HEIGHT = 0.0;

// ==================== A* Pathfinding ====================

/** Binary min-heap for A* open set */
class MinHeap {
  private data: Array<{ idx: number; f: number }> = [];

  get size(): number { return this.data.length; }

  push(idx: number, f: number): void {
    this.data.push({ idx, f });
    this._bubbleUp(this.data.length - 1);
  }

  pop(): number {
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this._sinkDown(0);
    }
    return top.idx;
  }

  private _bubbleUp(i: number): void {
    const d = this.data;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (d[i].f >= d[parent].f) break;
      [d[i], d[parent]] = [d[parent], d[i]];
      i = parent;
    }
  }

  private _sinkDown(i: number): void {
    const d = this.data;
    const n = d.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && d[left].f < d[smallest].f) smallest = left;
      if (right < n && d[right].f < d[smallest].f) smallest = right;
      if (smallest === i) break;
      [d[i], d[smallest]] = [d[smallest], d[i]];
      i = smallest;
    }
  }
}

/**
 * 8-directional A* on the downsampled height grid.
 *
 * Cost per step:
 *   α * (Δh)² + β * h_next * step_distance + γ * step_distance
 *
 * The β * h_next term makes the path actively seek low-elevation cells,
 * producing natural downhill → valley → uphill routes between peaks.
 */
function astarPath(
  heightMap: Float32Array,
  gridW: number,
  gridH: number,
  startGx: number,
  startGy: number,
  endGx: number,
  endGy: number,
  ds: number,
): Array<[number, number]> | null {
  const pw = Math.ceil(gridW / ds);
  const ph = Math.ceil(gridH / ds);

  const sx = Math.min(Math.max(Math.round(startGx / ds), 0), pw - 1);
  const sy = Math.min(Math.max(Math.round(startGy / ds), 0), ph - 1);
  const ex = Math.min(Math.max(Math.round(endGx / ds), 0), pw - 1);
  const ey = Math.min(Math.max(Math.round(endGy / ds), 0), ph - 1);

  if (sx === ex && sy === ey) return [[startGx, startGy], [endGx, endGy]];

  const totalCells = pw * ph;
  const gScore = new Float32Array(totalCells).fill(Infinity);
  const cameFrom = new Int32Array(totalCells).fill(-1);
  const closed = new Uint8Array(totalCells);

  const startIdx = sy * pw + sx;
  const endIdx = ey * pw + ex;
  gScore[startIdx] = 0;

  const heap = new MinHeap();
  const heuristic = (x: number, y: number) => {
    const dx = x - ex;
    const dy = y - ey;
    return GAMMA * Math.sqrt(dx * dx + dy * dy);
  };
  heap.push(startIdx, heuristic(sx, sy));

  // 8-directional neighbors
  const dirs = [
    [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1],
    [-1, -1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [1, 1, 1.414],
  ];

  /** Sample height from the full-res grid (nearest to downsampled cell) */
  const sampleH = (px: number, py: number): number => {
    const gx = Math.min(px * ds, gridW - 1);
    const gy = Math.min(py * ds, gridH - 1);
    return heightMap[gy * gridW + gx];
  };

  let iterations = 0;
  const maxIter = totalCells * 2; // safety limit

  while (heap.size > 0 && iterations++ < maxIter) {
    const cur = heap.pop();
    if (cur === endIdx) break;
    if (closed[cur]) continue;
    closed[cur] = 1;

    const cx = cur % pw;
    const cy = (cur - cx) / pw;
    const curH = sampleH(cx, cy);

    for (const [ddx, ddy, stepDist] of dirs) {
      const nx = cx + ddx;
      const ny = cy + ddy;
      if (nx < 0 || nx >= pw || ny < 0 || ny >= ph) continue;
      const ni = ny * pw + nx;
      if (closed[ni]) continue;

      const nH = sampleH(nx, ny);
      const dh = nH - curH;

      // Cost: Δh² keeps it smooth, h_next drives it into valleys, dist keeps it short
      const cost = ALPHA * dh * dh + BETA * nH * stepDist + GAMMA * stepDist;
      const tentG = gScore[cur] + cost;

      if (tentG < gScore[ni]) {
        gScore[ni] = tentG;
        cameFrom[ni] = cur;
        heap.push(ni, tentG + heuristic(nx, ny));
      }
    }
  }

  // Reconstruct path
  if (cameFrom[endIdx] === -1 && startIdx !== endIdx) return null;

  const pathIndices: number[] = [];
  let ci = endIdx;
  while (ci !== -1) {
    pathIndices.push(ci);
    ci = cameFrom[ci];
  }
  pathIndices.reverse();

  // Convert back to full-res grid coordinates
  const points: Array<[number, number]> = [];
  for (const idx of pathIndices) {
    const px = idx % pw;
    const py = (idx - px) / pw;
    points.push([px * ds, py * ds]);
  }

  // Ensure exact start/end
  points[0] = [startGx, startGy];
  points[points.length - 1] = [endGx, endGy];

  return points;
}

/**
 * Fallback: cubic Bézier between two peaks, sagging toward the midpoint.
 * Used when A* fails or peaks are extremely close.
 */
function bezierFallback(
  startGx: number, startGy: number,
  endGx: number, endGy: number,
  numSamples: number = 20,
): Array<[number, number]> {
  // Perpendicular offset for control points (slight sag)
  const dx = endGx - startGx;
  const dy = endGy - startGy;
  const len = Math.sqrt(dx * dx + dy * dy);
  const px = -dy / (len || 1) * len * 0.15;
  const py = dx / (len || 1) * len * 0.15;

  // Control points with slight perpendicular offset
  const cp1x = startGx + dx * 0.33 + px * 0.15;
  const cp1y = startGy + dy * 0.33 + py * 0.15;
  const cp2x = startGx + dx * 0.66 + px * 0.15;
  const cp2y = startGy + dy * 0.66 + py * 0.15;

  const points: Array<[number, number]> = [];
  for (let i = 0; i <= numSamples; i++) {
    const t = i / numSamples;
    const it = 1 - t;
    const x = it * it * it * startGx + 3 * it * it * t * cp1x + 3 * it * t * t * cp2x + t * t * t * endGx;
    const y = it * it * it * startGy + 3 * it * it * t * cp1y + 3 * it * t * t * cp2y + t * t * t * endGy;
    points.push([Math.round(x), Math.round(y)]);
  }
  return points;
}

// ==================== Smooth Path ====================

/**
 * Smooth a polyline path with a single 3-point moving average pass.
 * Just enough to remove grid-stepping artifacts from A*;
 * final visual smoothness comes from Catmull-Rom spline rendering.
 * Preserves start and end points exactly.
 */
function smoothPath(points: Array<[number, number]>): Array<[number, number]> {
  if (points.length < 3) return points;
  const smoothed: Array<[number, number]> = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    smoothed.push([
      (points[i - 1][0] + points[i][0] + points[i + 1][0]) / 3,
      (points[i - 1][1] + points[i][1] + points[i + 1][1]) / 3,
    ]);
  }
  smoothed.push(points[points.length - 1]);
  return smoothed;
}

// ==================== Path Decimation ====================

/**
 * Ramer-Douglas-Peucker polyline simplification.
 * Removes near-collinear points that the Catmull-Rom spline will reconstruct.
 */
function decimatePath(chain: Array<[number, number]>, epsilon: number): Array<[number, number]> {
  const n = chain.length;
  if (n <= 3) return chain;
  const [sx, sy] = chain[0];
  const [ex, ey] = chain[n - 1];
  const lx = ex - sx, ly = ey - sy;
  const lenSq = lx * lx + ly * ly;
  let maxDist = 0, maxIdx = 0;
  for (let i = 1; i < n - 1; i++) {
    const dx = chain[i][0] - sx, dy = chain[i][1] - sy;
    let dist: number;
    if (lenSq < 0.0001) {
      dist = Math.sqrt(dx * dx + dy * dy);
    } else {
      const t = (dx * lx + dy * ly) / lenSq;
      const px = sx + t * lx - chain[i][0];
      const py = sy + t * ly - chain[i][1];
      dist = Math.sqrt(px * px + py * py);
    }
    if (dist > maxDist) { maxDist = dist; maxIdx = i; }
  }
  if (maxDist <= epsilon) {
    return [chain[0], chain[n - 1]];
  }
  const left = decimatePath(chain.slice(0, maxIdx + 1), epsilon);
  const right = decimatePath(chain.slice(maxIdx), epsilon);
  return left.slice(0, -1).concat(right);
}

// ==================== Peak Edge Helper ====================

/**
 * Compute a point on the edge of a peak's plateau, toward another peak.
 * Returns screen-space coordinates of the edge point.
 */
function peakEdgePoint(
  peak: NodePeakInfo,
  otherPeak: NodePeakInfo,
): [number, number] {
  const dx = otherPeak.screenX - peak.screenX;
  const dy = otherPeak.screenY - peak.screenY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1) return [peak.screenX, peak.screenY];
  const nx = dx / dist;
  const ny = dy / dist;
  return [
    peak.screenX + nx * peak.plateauRadius,
    peak.screenY + ny * peak.plateauRadius,
  ];
}

// ==================== Public API ====================

/**
 * Compute reference link paths on the terrain heightMap.
 *
 * For each reference link between visible nodes, find the least-slope
 * route using A* on a downsampled height grid. Paths start and end at
 * the plateau edge of each peak, not the center. Falls back to Bézier
 * for very close/far peaks or when A* fails.
 *
 * @param heightMap - The terrain height map (gridW × gridH, values 0–1)
 * @param gridW - Height map width in grid cells
 * @param gridH - Height map height in grid cells
 * @param gs - Grid cell size in screen pixels
 * @param refLinks - Reference links to compute paths for
 * @param nodePeaks - Map of node id → NodePeakInfo (position + plateau radius)
 */
export function computeReferencePaths(
  heightMap: Float32Array,
  gridW: number,
  gridH: number,
  gs: number,
  refLinks: RefLink[],
  nodePeaks: Map<number, NodePeakInfo>,
): ReferencePathResult {
  if (refLinks.length === 0) return { paths: [] };

  const ds = Math.max(1, PATHFIND_DOWNSAMPLE);
  const paths: ReferencePath[] = [];

  // Deduplicate links (A→B == B→A for reference paths)
  const seen = new Set<string>();

  for (const link of refLinks) {
    const key = link.source < link.target
      ? `${link.source}:${link.target}`
      : `${link.target}:${link.source}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const srcPeak = nodePeaks.get(link.source);
    const tgtPeak = nodePeaks.get(link.target);
    if (!srcPeak || !tgtPeak) continue;

    // Compute edge points (start/end at plateau boundary, not center)
    const [srcEdgeX, srcEdgeY] = peakEdgePoint(srcPeak, tgtPeak);
    const [tgtEdgeX, tgtEdgeY] = peakEdgePoint(tgtPeak, srcPeak);

    // Convert edge screen coords to grid coords
    const srcGx = srcEdgeX / gs;
    const srcGy = srcEdgeY / gs;
    const tgtGx = tgtEdgeX / gs;
    const tgtGy = tgtEdgeY / gs;

    const gdx = tgtGx - srcGx;
    const gdy = tgtGy - srcGy;
    const gridDist = Math.sqrt(gdx * gdx + gdy * gdy);

    let gridPoints: Array<[number, number]> | null = null;

    if (gridDist < MIN_ASTAR_GRID_DIST) {
      // Very close peaks — simple Bézier
      gridPoints = bezierFallback(srcGx, srcGy, tgtGx, tgtGy, 12);
    } else if (gridDist > MAX_ASTAR_GRID_DIST) {
      // Too far — Bézier with more samples
      gridPoints = bezierFallback(srcGx, srcGy, tgtGx, tgtGy, 30);
    } else {
      // A* pathfinding
      gridPoints = astarPath(heightMap, gridW, gridH,
        Math.round(srcGx), Math.round(srcGy),
        Math.round(tgtGx), Math.round(tgtGy), ds);
      if (!gridPoints) {
        // Fallback on A* failure
        gridPoints = bezierFallback(srcGx, srcGy, tgtGx, tgtGy, 20);
      }
    }

    if (!gridPoints || gridPoints.length < 2) continue;

    // Ensure exact edge start/end
    gridPoints[0] = [srcGx, srcGy];
    gridPoints[gridPoints.length - 1] = [tgtGx, tgtGy];

    // Single smoothing pass to remove A* grid artifacts,
    // then decimate — Catmull-Rom spline rendering handles final smoothness
    gridPoints = smoothPath(gridPoints);
    gridPoints = decimatePath(gridPoints, 1.0);  // epsilon in grid cells

    // Compute average slope along path
    let totalSlope = 0;
    let slopeCount = 0;
    for (let i = 1; i < gridPoints.length; i++) {
      const [px, py] = gridPoints[i];
      const [ppx, ppy] = gridPoints[i - 1];
      const gxA = Math.min(Math.max(Math.round(ppx), 0), gridW - 1);
      const gyA = Math.min(Math.max(Math.round(ppy), 0), gridH - 1);
      const gxB = Math.min(Math.max(Math.round(px), 0), gridW - 1);
      const gyB = Math.min(Math.max(Math.round(py), 0), gridH - 1);
      const hA = heightMap[gyA * gridW + gxA];
      const hB = heightMap[gyB * gridW + gxB];
      const segDx = px - ppx;
      const segDy = py - ppy;
      const segLen = Math.sqrt(segDx * segDx + segDy * segDy);
      if (segLen > 0) {
        totalSlope += Math.abs(hB - hA) / segLen;
        slopeCount++;
      }
    }
    const avgSlope = slopeCount > 0 ? totalSlope / slopeCount : 0;

    // Convert grid coords → screen coords
    const screenPoints: Array<[number, number]> = gridPoints.map(([gx, gy]) => [gx * gs, gy * gs]);

    paths.push({
      sourceId: link.source,
      targetId: link.target,
      screenPoints,
      avgSlope,
    });
  }

  return { paths };
}

/**
 * Apply subtle terrain erosion along computed reference paths.
 *
 * Slightly reduces heightMap values in a small corridor around each path,
 * creating shallow valleys where reference links pass. Multiple overlapping
 * paths erode cumulatively.
 *
 * Constraints:
 * - Node peak heights are NOT altered (protected by nodePeakGridCells)
 * - Heights are clamped to [EROSION_MIN_HEIGHT, ∞)
 * - No physics side-effects
 *
 * @param heightMap - Mutable height map to erode in-place
 * @param gridW - Grid width
 * @param gridH - Grid height
 * @param gs - Grid cell size in pixels
 * @param paths - Computed reference paths (in screen coords, divide by gs for grid)
 * @param nodePeakGridCells - Protected grid cells (node peak positions)
 */
export function applyPathErosion(
  heightMap: Float32Array,
  gridW: number,
  gridH: number,
  gs: number,
  paths: ReferencePath[],
  nodePeakGridCells: Set<number>,
): void {
  if (paths.length === 0) return;

  // Track erosion multiplier per cell (accumulated across paths)
  // We apply erosion lazily: multiply height by factor at the end
  const erosionMap = new Float32Array(gridW * gridH).fill(1.0);

  for (const path of paths) {
    const pts = path.screenPoints;
    for (let i = 0; i < pts.length; i++) {
      const gx = Math.round(pts[i][0] / gs);
      const gy = Math.round(pts[i][1] / gs);

      // Erode in a small radius around the path point
      for (let dy = -EROSION_RADIUS; dy <= EROSION_RADIUS; dy++) {
        for (let dx = -EROSION_RADIUS; dx <= EROSION_RADIUS; dx++) {
          const cx = gx + dx;
          const cy = gy + dy;
          if (cx < 0 || cx >= gridW || cy < 0 || cy >= gridH) continue;

          const distSq = dx * dx + dy * dy;
          if (distSq > EROSION_RADIUS * EROSION_RADIUS) continue;

          const idx = cy * gridW + cx;

          // Skip protected peak cells
          if (nodePeakGridCells.has(idx)) continue;

          // Smooth falloff: stronger erosion at path center
          const dist = Math.sqrt(distSq);
          const falloff = 1 - dist / (EROSION_RADIUS + 0.5);
          const factor = 1 - (1 - EROSION_FACTOR) * falloff;

          erosionMap[idx] *= factor;
        }
      }
    }
  }

  // Apply accumulated erosion to heightMap
  for (let i = 0; i < gridW * gridH; i++) {
    if (erosionMap[i] < 1.0) {
      heightMap[i] = Math.max(EROSION_MIN_HEIGHT, heightMap[i] * erosionMap[i]);
    }
  }
}
