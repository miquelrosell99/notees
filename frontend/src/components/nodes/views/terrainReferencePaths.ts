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
  /** Per-point multiplicity: how many paths share each point (≥1) */
  pointMultiplicity: number[];
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
 * A* cost weights — tuned for natural topographic paths.
 *
 * ALPHA: penalizes absolute height changes |Δh| (prefers level terrain)
 * BETA:  penalizes gradient discontinuity |grad − prevGrad| (smooth slope transitions)
 * GAMMA: penalizes distance (keeps path reasonably short)
 */
const ALPHA = 1.5;   // |Δh| penalty
const BETA = 1.0;    // gradient continuity penalty
const GAMMA = 0.1;   // distance penalty

/** Max path distance in grid cells before falling back to Bézier */
const MAX_ASTAR_GRID_DIST = 300;

/** Min distance in grid cells — skip A* for very close peaks */
const MIN_ASTAR_GRID_DIST = 3;

/** Number of perimeter sample points around each peak plateau */
const PERIMETER_SAMPLES = 16;

/** Merge radius in screen pixels — paths within this distance snap together */
const PATH_MERGE_RADIUS = 20;

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
 * 8-directional A* with gradient continuity tracking.
 *
 * Cost per step:
 *   α * |Δh| + β * |gradient − prevGradient| + γ * distance
 *
 * Paths naturally follow terrain features — climbing ridges, descending
 * into valleys, and crossing saddles with smooth slope transitions.
 *
 * Uses multi-source start (all plateau perimeter cells) and multi-target
 * end (all target perimeter cells) so the best entry/exit points are
 * chosen automatically.
 */
function astarPath(
  heightMap: Float32Array,
  gridW: number,
  gridH: number,
  startCells: Array<[number, number]>,
  endCells: Array<[number, number]>,
  ds: number,
): Array<[number, number]> | null {
  const pw = Math.ceil(gridW / ds);
  const ph = Math.ceil(gridH / ds);

  // Build end-cell set for fast goal check
  const endSet = new Set<number>();
  let goalCenterX = 0, goalCenterY = 0;
  for (const [gx, gy] of endCells) {
    const px = Math.min(Math.max(Math.round(gx / ds), 0), pw - 1);
    const py = Math.min(Math.max(Math.round(gy / ds), 0), ph - 1);
    endSet.add(py * pw + px);
    goalCenterX += px;
    goalCenterY += py;
  }
  if (endSet.size === 0) return null;
  goalCenterX /= endSet.size;
  goalCenterY /= endSet.size;

  const totalCells = pw * ph;
  const gScore = new Float32Array(totalCells).fill(Infinity);
  const cameFrom = new Int32Array(totalCells).fill(-1);
  const closed = new Uint8Array(totalCells);
  // Per-cell gradient tracking for slope continuity
  const prevGrad = new Float32Array(totalCells);
  const hasGrad = new Uint8Array(totalCells); // 0 = no previous gradient

  /** Sample height from the full-res grid (nearest to downsampled cell) */
  const sampleH = (px: number, py: number): number => {
    const gx = Math.min(px * ds, gridW - 1);
    const gy = Math.min(py * ds, gridH - 1);
    return heightMap[gy * gridW + gx];
  };

  // 3D heuristic: Euclidean distance including height difference to goal center
  const goalH = sampleH(Math.round(goalCenterX), Math.round(goalCenterY));
  const heuristic = (x: number, y: number) => {
    const dx = x - goalCenterX;
    const dy = y - goalCenterY;
    const dh = sampleH(x, y) - goalH;
    return GAMMA * Math.sqrt(dx * dx + dy * dy + dh * dh);
  };

  const heap = new MinHeap();

  // Seed with all start perimeter cells (multi-source)
  for (const [gx, gy] of startCells) {
    const px = Math.min(Math.max(Math.round(gx / ds), 0), pw - 1);
    const py = Math.min(Math.max(Math.round(gy / ds), 0), ph - 1);
    const idx = py * pw + px;
    if (gScore[idx] <= 0) continue; // already seeded
    gScore[idx] = 0;
    hasGrad[idx] = 0;
    heap.push(idx, heuristic(px, py));
  }

  // 8-directional neighbors
  const dirs: Array<[number, number, number]> = [
    [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1],
    [-1, -1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [1, 1, 1.414],
  ];

  let iterations = 0;
  const maxIter = totalCells * 2; // safety limit
  let endIdx = -1;

  while (heap.size > 0 && iterations++ < maxIter) {
    const cur = heap.pop();
    if (endSet.has(cur)) { endIdx = cur; break; }
    if (closed[cur]) continue;
    closed[cur] = 1;

    const cx = cur % pw;
    const cy = (cur - cx) / pw;
    const curH = sampleH(cx, cy);
    const curHasGrad = hasGrad[cur] !== 0;
    const curGrad = curHasGrad ? prevGrad[cur] : 0;

    for (const [ddx, ddy, stepDist] of dirs) {
      const nx = cx + ddx;
      const ny = cy + ddy;
      if (nx < 0 || nx >= pw || ny < 0 || ny >= ph) continue;
      const ni = ny * pw + nx;
      if (closed[ni]) continue;

      const nH = sampleH(nx, ny);
      const dh = nH - curH;
      const gradient = dh / stepDist;

      // Gradient continuity penalty: penalize abrupt slope changes
      let slopePenalty = 0;
      if (curHasGrad) {
        slopePenalty = Math.abs(gradient - curGrad);
      }

      // Cost: α * |Δh| + β * |grad − prevGrad| + γ * distance
      const cost = ALPHA * Math.abs(dh) + BETA * slopePenalty + GAMMA * stepDist;
      const tentG = gScore[cur] + cost;

      if (tentG < gScore[ni]) {
        gScore[ni] = tentG;
        cameFrom[ni] = cur;
        prevGrad[ni] = gradient;
        hasGrad[ni] = 1;
        heap.push(ni, tentG + heuristic(nx, ny));
      }
    }
  }

  // Reconstruct path
  if (endIdx === -1) return null;

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

// ==================== Plateau Perimeter Helper ====================

/**
 * Sample evenly-spaced perimeter cells around a peak's plateau edge.
 * Returns grid-coordinate points that lie on the plateau boundary.
 * Used as multi-source / multi-target seeds for A*.
 */
function getPlateauPerimeterCells(
  peakScreenX: number,
  peakScreenY: number,
  plateauRadius: number,
  gs: number,
  gridW: number,
  gridH: number,
): Array<[number, number]> {
  const centerGx = peakScreenX / gs;
  const centerGy = peakScreenY / gs;
  const radiusGrid = plateauRadius / gs;
  const cells: Array<[number, number]> = [];
  const seen = new Set<number>();
  for (let i = 0; i < PERIMETER_SAMPLES; i++) {
    const angle = (i / PERIMETER_SAMPLES) * 2 * Math.PI;
    const gx = Math.round(centerGx + Math.cos(angle) * radiusGrid);
    const gy = Math.round(centerGy + Math.sin(angle) * radiusGrid);
    if (gx < 0 || gx >= gridW || gy < 0 || gy >= gridH) continue;
    const key = gy * gridW + gx;
    if (seen.has(key)) continue;
    seen.add(key);
    cells.push([gx, gy]);
  }
  return cells;
}

// ==================== Public API ====================

/**
 * Compute reference link paths on the terrain heightMap.
 *
 * For each reference link between visible nodes, find a natural
 * topographic route using A* with gradient continuity on a downsampled
 * height grid. Paths start and end at the plateau perimeter of each
 * peak, with the best entry/exit points chosen automatically by
 * multi-source / multi-target A*.
 *
 * Falls back to Bézier for very close/far peaks or when A* fails.
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

    // Compute plateau perimeter cells for multi-source / multi-target A*
    const srcPerimeter = getPlateauPerimeterCells(
      srcPeak.screenX, srcPeak.screenY, srcPeak.plateauRadius, gs, gridW, gridH,
    );
    const tgtPerimeter = getPlateauPerimeterCells(
      tgtPeak.screenX, tgtPeak.screenY, tgtPeak.plateauRadius, gs, gridW, gridH,
    );

    // Approximate distance between peak centers (grid coords)
    const srcCenterGx = srcPeak.screenX / gs;
    const srcCenterGy = srcPeak.screenY / gs;
    const tgtCenterGx = tgtPeak.screenX / gs;
    const tgtCenterGy = tgtPeak.screenY / gs;
    const gdx = tgtCenterGx - srcCenterGx;
    const gdy = tgtCenterGy - srcCenterGy;
    const gridDist = Math.sqrt(gdx * gdx + gdy * gdy);

    let gridPoints: Array<[number, number]> | null = null;

    if (gridDist < MIN_ASTAR_GRID_DIST || srcPerimeter.length === 0 || tgtPerimeter.length === 0) {
      // Very close peaks or degenerate perimeters — simple Bézier
      gridPoints = bezierFallback(srcCenterGx, srcCenterGy, tgtCenterGx, tgtCenterGy, 12);
    } else if (gridDist > MAX_ASTAR_GRID_DIST) {
      // Too far — Bézier with more samples
      gridPoints = bezierFallback(srcCenterGx, srcCenterGy, tgtCenterGx, tgtCenterGy, 30);
    } else {
      // Multi-source / multi-target A* with gradient continuity
      gridPoints = astarPath(heightMap, gridW, gridH, srcPerimeter, tgtPerimeter, ds);
      if (!gridPoints) {
        // Fallback on A* failure
        gridPoints = bezierFallback(srcCenterGx, srcCenterGy, tgtCenterGx, tgtCenterGy, 20);
      }
    }

    if (!gridPoints || gridPoints.length < 2) continue;

    // Anchor path at node centers (grid coords) so there are no gaps
    const srcCenterG: [number, number] = [srcCenterGx, srcCenterGy];
    const tgtCenterG: [number, number] = [tgtCenterGx, tgtCenterGy];
    gridPoints.unshift(srcCenterG);
    gridPoints.push(tgtCenterG);

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
      pointMultiplicity: new Array(screenPoints.length).fill(1),
      avgSlope,
    });
  }

  // Merge nearby path segments and compute per-point multiplicity
  if (paths.length > 1) {
    mergeNearbyPaths(paths, PATH_MERGE_RADIUS);
  }

  return { paths };
}

// ==================== Path Merging ====================

/**
 * Merge nearby path segments so that paths travelling in similar
 * directions snap to shared waypoints where they're close together,
 * then split apart naturally.  Per-point multiplicity is set to the
 * number of paths sharing each location.
 *
 * Algorithm:
 * 1. Resample all paths to uniform spacing (~mergeRadius / 2)
 * 2. Bucket resampled points into a spatial grid (cell = mergeRadius)
 * 3. For cells with points from multiple paths, snap to centroid
 * 4. Write multiplicity = number of distinct paths in the cell
 * 5. Smooth the result to remove snapping artifacts
 */
function mergeNearbyPaths(paths: ReferencePath[], mergeRadius: number): void {
  if (paths.length < 2) return;

  // --- 1. Resample all paths to uniform step ≈ mergeRadius / 2 ---
  const step = Math.max(4, mergeRadius * 0.5);
  const resampled: Array<Array<[number, number]>> = [];
  for (const path of paths) {
    resampled.push(resamplePolyline(path.screenPoints, step));
  }

  // --- 2. Spatial hash: bucket points by grid cell ---
  const cellSize = mergeRadius;
  const cellKey = (x: number, y: number): number => {
    const cx = Math.floor(x / cellSize);
    const cy = Math.floor(y / cellSize);
    return cx * 100003 + cy; // large prime avoids collisions
  };

  // Map from cell key → list of { pathIdx, ptIdx }
  const buckets = new Map<number, Array<{ pi: number; qi: number }>>(); // pi=path, qi=point
  for (let pi = 0; pi < resampled.length; pi++) {
    const pts = resampled[pi];
    for (let qi = 0; qi < pts.length; qi++) {
      const k = cellKey(pts[qi][0], pts[qi][1]);
      let list = buckets.get(k);
      if (!list) { list = []; buckets.set(k, list); }
      list.push({ pi, qi });
    }
  }

  // --- 3. For multi-path cells, snap to centroid and set multiplicity ---
  const multiplicity: Array<number[]> = resampled.map(pts => new Array(pts.length).fill(1));

  for (const entries of buckets.values()) {
    // Count distinct paths in this cell
    const pathSet = new Set<number>();
    for (const e of entries) pathSet.add(e.pi);
    if (pathSet.size < 2) continue;

    // Compute centroid of all points in this cell
    let cx = 0, cy = 0;
    for (const e of entries) {
      cx += resampled[e.pi][e.qi][0];
      cy += resampled[e.pi][e.qi][1];
    }
    cx /= entries.length;
    cy /= entries.length;

    // Snap points to centroid and record multiplicity
    const mult = pathSet.size;
    for (const e of entries) {
      resampled[e.pi][e.qi] = [cx, cy];
      multiplicity[e.pi][e.qi] = mult;
    }
  }

  // --- 4. Smooth snapped paths to remove grid artifacts ---
  for (let pi = 0; pi < resampled.length; pi++) {
    const pts = resampled[pi];
    if (pts.length < 3) continue;
    // Single pass moving average (preserve start/end)
    const smoothed: Array<[number, number]> = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      smoothed.push([
        (pts[i - 1][0] + pts[i][0] + pts[i + 1][0]) / 3,
        (pts[i - 1][1] + pts[i][1] + pts[i + 1][1]) / 3,
      ]);
    }
    smoothed.push(pts[pts.length - 1]);
    resampled[pi] = smoothed;
  }

  // --- 5. Write back to paths ---
  for (let pi = 0; pi < paths.length; pi++) {
    paths[pi].screenPoints = resampled[pi];
    paths[pi].pointMultiplicity = multiplicity[pi];
  }
}

/**
 * Resample a polyline to approximately uniform spacing.
 * Preserves start and end points exactly.
 */
function resamplePolyline(
  points: Array<[number, number]>,
  spacing: number,
): Array<[number, number]> {
  if (points.length < 2) return [...points];

  // Compute cumulative arc length
  const cumLen = [0];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    cumLen.push(cumLen[i - 1] + Math.sqrt(dx * dx + dy * dy));
  }
  const totalLen = cumLen[cumLen.length - 1];
  if (totalLen < spacing) return [points[0], points[points.length - 1]];

  const numSamples = Math.max(2, Math.ceil(totalLen / spacing) + 1);
  const result: Array<[number, number]> = [points[0]];
  let segIdx = 0;

  for (let si = 1; si < numSamples - 1; si++) {
    const targetLen = (si / (numSamples - 1)) * totalLen;
    // Advance to the segment containing targetLen
    while (segIdx < cumLen.length - 2 && cumLen[segIdx + 1] < targetLen) segIdx++;
    const segLen = cumLen[segIdx + 1] - cumLen[segIdx];
    const t = segLen > 0 ? (targetLen - cumLen[segIdx]) / segLen : 0;
    result.push([
      points[segIdx][0] + t * (points[segIdx + 1][0] - points[segIdx][0]),
      points[segIdx][1] + t * (points[segIdx + 1][1] - points[segIdx][1]),
    ]);
  }

  result.push(points[points.length - 1]);
  return result;
}

// ==================== Path Erosion ====================

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
