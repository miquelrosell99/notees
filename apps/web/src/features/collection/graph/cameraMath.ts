/**
 * cameraMath.ts — the pure camera helpers shared by every graph zoom/pan
 * surface: the main canvas wheel, the minimap wheel, the control dock's
 * zoom buttons, the keyboard shortcuts, and the Focus bbox fit.
 *
 * One convention everywhere: the wheel factor (1.12), the 0.02–40 clamp,
 * and cursor anchoring (the world point under the anchor stays put).
 * The camera's (x, y) IS the world point at the canvas center, so
 * center-anchored zoom is a pure zoom change.
 */

export interface GraphCamera {
  x: number;
  y: number;
  zoom: number;
}

/** The v1 clamp range — one home so every surface agrees. */
export const GRAPH_ZOOM_MIN = 0.02;
export const GRAPH_ZOOM_MAX = 40;
/** The v1 wheel/button zoom factor. */
export const GRAPH_ZOOM_FACTOR = 1.12;

export function clampZoom(zoom: number): number {
  return Math.max(GRAPH_ZOOM_MIN, Math.min(zoom, GRAPH_ZOOM_MAX));
}

/** Wheel deltaY → zoom factor (negative delta zooms in), the v1 convention. */
export function wheelZoomFactor(deltaY: number): number {
  return deltaY < 0 ? GRAPH_ZOOM_FACTOR : 1 / GRAPH_ZOOM_FACTOR;
}

/**
 * Cursor-anchored zoom: after the zoom, the world point (anchorX, anchorY)
 * still sits under the same screen pixel. Returns a new camera.
 */
export function zoomAtWorldPoint(
  cam: GraphCamera,
  anchorX: number,
  anchorY: number,
  factor: number,
): GraphCamera {
  const zoom = clampZoom(cam.zoom * factor);
  const applied = zoom / cam.zoom;
  return {
    x: anchorX + (cam.x - anchorX) / applied,
    y: anchorY + (cam.y - anchorY) / applied,
    zoom,
  };
}

/** Zoom anchored at the canvas center — the center IS the camera position. */
export function zoomAtCenter(cam: GraphCamera, direction: 1 | -1): GraphCamera {
  const factor = direction > 0 ? GRAPH_ZOOM_FACTOR : 1 / GRAPH_ZOOM_FACTOR;
  return { ...cam, zoom: clampZoom(cam.zoom * factor) };
}

/**
 * Pan by a screen-space delta (px at the current zoom; +right/+down).
 * Arrow keys and any pixel-pan surface share this.
 */
export function panByScreenDelta(
  cam: GraphCamera,
  dxPx: number,
  dyPx: number,
): GraphCamera {
  return {
    ...cam,
    x: cam.x + dxPx / cam.zoom,
    y: cam.y + dyPx / cam.zoom,
  };
}

/**
 * Focus fit: the camera that centers on `bbox` (world units) with ~paddingPx
 * of breathing room in a viewW×viewH px viewport, zoom clamped to the graph
 * range. An empty bbox returns null (nothing to focus).
 */
export function fitBoundingBoxCamera(
  bbox: { minX: number; minY: number; maxX: number; maxY: number } | null,
  viewWidthPx: number,
  viewHeightPx: number,
  paddingPx = 60,
): GraphCamera | null {
  if (bbox === null) return null;
  const bw = bbox.maxX - bbox.minX;
  const bh = bbox.maxY - bbox.minY;
  if (!Number.isFinite(bw) || !Number.isFinite(bh)) return null;
  // Padding is screen-constant: convert to world units at the fit zoom
  // (two passes converge tightly for the small paddings we use).
  let zoom = clampZoom(
    Math.min(
      viewWidthPx / Math.max(bw, 1e-6),
      viewHeightPx / Math.max(bh, 1e-6),
    ),
  );
  const padWorld = paddingPx / zoom;
  zoom = clampZoom(
    Math.min(
      viewWidthPx / Math.max(bw + 2 * padWorld, 1e-6),
      viewHeightPx / Math.max(bh + 2 * padWorld, 1e-6),
    ),
  );
  return {
    x: bbox.minX + bw / 2,
    y: bbox.minY + bh / 2,
    zoom,
  };
}

/** The bbox over a subset of nodes, from the latest position frame. */
export function bboxForNodes(
  positions: Float32Array,
  nodeIds: string[],
  wanted: ReadonlySet<string>,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = false;
  for (let i = 0; i < nodeIds.length; i++) {
    if (!wanted.has(nodeIds[i]!)) continue;
    found = true;
    const x = positions[i * 2]!;
    const y = positions[i * 2 + 1]!;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (!found) return null;
  return { minX, minY, maxX, maxY };
}
