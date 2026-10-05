/**
 * minimap.ts — the floating overview (the parked §34.80 follow-up): a tiny
 * Canvas 2D projection of the SAME positions the main renderer draws, with
 * the camera's viewport rectangle and click/drag navigation. No second
 * physics — the minimap mirrors the live frame, so it can never drift.
 */

export interface MinimapCamera {
  x: number;
  y: number;
  zoom: number;
}

export interface MinimapFrame {
  positions: Float32Array;
  nodeIds: string[];
  nodeCount: number;
}

/** Fit the whole node set into the minimap's world rect. */
function bounds(positions: Float32Array, count: number): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    minX = Math.min(minX, positions[i * 2]!);
    maxX = Math.max(maxX, positions[i * 2]!);
    minY = Math.min(minY, positions[i * 2 + 1]!);
    maxY = Math.max(maxY, positions[i * 2 + 1]!);
  }
  if (!Number.isFinite(minX)) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
  if (minX === maxX) maxX = minX + 1;
  if (minY === maxY) maxY = minY + 1;
  return { minX, minY, maxX, maxY };
}

export const GraphMinimap = {
  draw(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    positions: Float32Array,
    _order: string[],
    camera: MinimapCamera,
    viewWidthPx: number,
    viewHeightPx: number,
  ): void {
    const count = Math.floor(positions.length / 2);
    ctx.clearRect(0, 0, width, height);
    if (count === 0) return;
    const b = bounds(positions, count);
    const scale = Math.min(width / (b.maxX - b.minX), height / (b.maxY - b.minY)) * 0.92;
    const offsetX = (width - (b.maxX - b.minX) * scale) / 2;
    const offsetY = (height - (b.maxY - b.minY) * scale) / 2;
    const toMiniX = (wx: number): number => offsetX + (wx - b.minX) * scale;
    const toMiniY = (wy: number): number => offsetY + (wy - b.minY) * scale;

    ctx.fillStyle = "rgba(140, 140, 150, 0.55)";
    for (let i = 0; i < count; i++) {
      ctx.fillRect(toMiniX(positions[i * 2]!) - 1, toMiniY(positions[i * 2 + 1]!) - 1, 2, 2);
    }

    // Viewport rectangle — the main canvas shows viewWidthPx / zoom world
    // units across; both the dots and the rect ride the same linear map.
    const viewW = viewWidthPx / Math.max(0.05, camera.zoom);
    const viewH = viewHeightPx / Math.max(0.05, camera.zoom);
    ctx.strokeStyle = "rgba(90, 90, 100, 0.9)";
    ctx.lineWidth = 1;
    ctx.strokeRect(
      toMiniX(camera.x - viewW / 2),
      toMiniY(camera.y - viewH / 2),
      viewW * scale,
      viewH * scale,
    );
  },

  /** Map a minimap pixel to world coordinates (click/drag navigation). */
  screenToWorld(
    miniX: number,
    miniY: number,
    width: number,
    height: number,
    frame: MinimapFrame | null,
    _camera: MinimapCamera,
  ): { x: number; y: number } {
    if (frame === null || frame.nodeCount === 0) return { x: 0, y: 0 };
    const b = bounds(frame.positions, frame.nodeCount);
    const scale = Math.min(width / (b.maxX - b.minX), height / (b.maxY - b.minY)) * 0.92;
    const offsetX = (width - (b.maxX - b.minX) * scale) / 2;
    const offsetY = (height - (b.maxY - b.minY) * scale) / 2;
    return {
      x: b.minX + (miniX - offsetX) / scale,
      y: b.minY + (miniY - offsetY) / scale,
    };
  },
};
