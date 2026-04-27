/**
 * Terrain stamp engine — pure computational geometry for height-map generation.
 *
 * Extracted from TerrainRenderer.tsx to keep the React component focused on
 * rendering lifecycle and interaction.
 */

import {
  TERRAIN_BASE_PLATEAU_RADIUS,
  TERRAIN_PEAK_PLATEAU_BONUS,
  TERRAIN_BASE_SLOPE_RADIUS,
  TERRAIN_PEAK_SLOPE_RADIUS_BONUS,
  TERRAIN_ANISOTROPY,
  TERRAIN_NOISE_STRENGTH,
  TERRAIN_SLOPE_POWER,
} from './viewTypes';

/** Fast integer hash for deterministic per-cell noise (no Math.random, stable across frames) */
export const ihash = (a: number, b: number): number => {
  let h = (a * 374761393 + b * 668265263 + 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) & 0x7fffffff) / 0x7fffffff; // 0..1
};

// ==================== Per-Node Stamp System ====================
// Each node has a local height grid ("stamp") computed independently.
// Stamps are position-independent and cached — only recomputed when
// the node's height, peak size, grid resolution, or child directions change.
// Building the global height map is just blitting (MAX-merging) stamps
// onto the grid at each node's position, which is much cheaper than
// re-doing sqrt/atan2/pow/noise per cell every frame.

export interface NodeStamp {
  /** Local height values (centered at cx,cy) */
  heights: Float32Array;
  /** Stamp dimensions in grid cells */
  w: number;
  h: number;
  /** Center offset in stamp-local coords (grid cells) */
  cx: number;
  cy: number;
}

/** Cache entry stores the stamp and the parameters it was computed for */
export interface StampCacheEntry {
  stamp: NodeStamp;
  H: number;
  peakSize: number;
  gs: number;
  dirsHash: number;
}

/**
 * Quantize child directions into a stable hash.
 * Directions are snapped to 16 compass points so the cache stays
 * valid across small angular changes during simulation.
 */
export const hashChildDirs = (dirs: Array<{ nx: number; ny: number }>): number => {
  if (dirs.length === 0) return 0;
  let h = dirs.length * 97;
  for (const d of dirs) {
    // Quantize angle to 16 compass directions (22.5° steps)
    const angle = Math.round(Math.atan2(d.ny, d.nx) * 8 / Math.PI);
    h = (h * 31 + (angle + 8)) | 0; // +8 to avoid negatives
  }
  return h;
};

/**
 * Compute a height stamp for a single node.
 * The stamp is a local grid centered at (0,0) in grid-cell units.
 */
export const computeNodeStamp = (
  nodeId: number,
  H: number,
  peakSize: number,
  gs: number,
  dirs: Array<{ nx: number; ny: number }>,
): NodeStamp => {
  const Rp = (TERRAIN_BASE_PLATEAU_RADIUS + TERRAIN_PEAK_PLATEAU_BONUS * peakSize) / gs;
  const Rs = (TERRAIN_BASE_SLOPE_RADIUS + TERRAIN_PEAK_SLOPE_RADIUS_BONUS * peakSize) / gs;
  const RpSq = Rp * Rp;
  const RsSq = Rs * Rs;
  const invSlopeRangeSq = 1 / (RsSq - RpSq);
  const hasDirs = dirs.length > 0;

  // Stamp radius (in grid cells) — expanded for anisotropy
  const radius = Math.ceil(Rs * (hasDirs ? (1 + TERRAIN_ANISOTROPY) : 1));
  const w = radius * 2 + 1;
  const h = w; // square stamp
  const cx = radius;
  const cy = radius;
  const heights = new Float32Array(w * h);

  for (let sy = 0; sy < h; sy++) {
    const dy = sy - cy;
    const rowOff = sy * w;
    for (let sx = 0; sx < w; sx++) {
      const dx = sx - cx;
      let distSq = dx * dx + dy * dy;

      // Star-shaped: reduce effective distance when aligned with child directions
      if (hasDirs && distSq > 0.01) {
        const invDist = 1 / Math.sqrt(distSq);
        const udx = dx * invDist;
        const udy = dy * invDist;
        let maxAlign = 0;
        for (let d = 0; d < dirs.length; d++) {
          const dot = udx * dirs[d].nx + udy * dirs[d].ny;
          if (dot > maxAlign) maxAlign = dot;
        }
        if (maxAlign > 0.4) {
          const ramp = (maxAlign - 0.4) / 0.6;
          const shrink = 1 / (1 + TERRAIN_ANISOTROPY * ramp * ramp);
          distSq *= shrink * shrink;
        }
      }

      if (distSq > RsSq) continue;

      // Angular noise for organic shape
      if (TERRAIN_NOISE_STRENGTH > 0 && distSq > 0.01) {
        const ang = Math.atan2(dy, dx);
        const n1 = ihash(nodeId, Math.floor(ang * 3 + 100)) * 2 - 1;
        const n2 = ihash(nodeId, Math.floor(ang * 7 + 200)) * 2 - 1;
        const noise = (n1 * 0.7 + n2 * 0.3) * TERRAIN_NOISE_STRENGTH;
        distSq *= (1 + noise) * (1 + noise);
      }

      const ndSq = distSq <= RpSq ? 0 : (distSq - RpSq) * invSlopeRangeSq;
      const falloff = Math.pow(1 - ndSq, TERRAIN_SLOPE_POWER);
      heights[rowOff + sx] = H * falloff;
    }
  }

  return { heights, w, h, cx, cy };
};
