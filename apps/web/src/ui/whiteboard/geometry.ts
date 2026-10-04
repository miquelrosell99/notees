/**
 * Whiteboard geometry math — the pure, React-free half of the canvas
 * toolset (§34.19 whiteboard row): world-space bounds, marquee hit-testing,
 * grid snapping, and the alignment/distribution transforms. All functions
 * take and return plain data so the canvas and the tests exercise exactly
 * the same code the gestures run.
 */

import type { CardGeometry, WhiteboardLayout, WhiteboardShape, WhiteboardStroke } from "../whiteboard-layout.js";

/** World-space rectangle (x/y = top-left, w/h may not be negative). */
export interface WorldRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Visible world-space grid step — the dot grid the canvas renders. */
export const GRID_STEP = 24;

export function snapToGrid(value: number, step: number = GRID_STEP): number {
  return Math.round(value / step) * step;
}

/** Normalize any (possibly negative-w/h) box to a top-left anchored rect. */
export function normalizeRect(x: number, y: number, w: number, h: number): WorldRect {
  return {
    x: Math.min(x, x + w),
    y: Math.min(y, y + h),
    w: Math.abs(w),
    h: Math.abs(h),
  };
}

/** The marquee/hit bounds of a shape (lines/arrows use their endpoint box). */
export function shapeBounds(shape: Pick<WhiteboardShape, "x" | "y" | "w" | "h">): WorldRect {
  return normalizeRect(shape.x, shape.y, shape.w, shape.h);
}

/** The bounds of a freehand stroke's point cloud; null for degenerate input. */
export function strokeBounds(points: readonly number[]): WorldRect | null {
  if (points.length < 2) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i]!;
    const y = points[i + 1]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function rectsIntersect(a: WorldRect, b: WorldRect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

export function unionRects(rects: readonly WorldRect[]): WorldRect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.w > maxX) maxX = r.x + r.w;
    if (r.y + r.h > maxY) maxY = r.y + r.h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * The bounds of everything on the canvas: card geometries (only the ids
 * actually rendered as cards), shapes, and strokes — null for an empty board.
 */
export function layoutBounds(layout: WhiteboardLayout, renderedCardIds: readonly string[]): WorldRect | null {
  const rects: WorldRect[] = [];
  for (const id of renderedCardIds) {
    const geometry = layout.cards[id];
    if (geometry !== undefined) rects.push(geometry);
  }
  for (const shape of layout.shapes) rects.push(shapeBounds(shape));
  for (const stroke of layout.strokes) {
    const bounds = strokeBounds(stroke.points);
    if (bounds !== null) rects.push(bounds);
  }
  return unionRects(rects);
}

/**
 * Marquee hit-test: element ids (card node ids, shape ids, stroke ids) whose
 * bounds intersect the world-space marquee rect. Cards are hit by their
 * geometry only when they are rendered on the canvas (geometry keyed to a
 * non-rendered child must not select).
 */
export function marqueeHit(layout: WhiteboardLayout, renderedCardIds: readonly string[], rect: WorldRect): string[] {
  const hits: string[] = [];
  for (const id of renderedCardIds) {
    const geometry = layout.cards[id];
    if (geometry !== undefined && rectsIntersect(rect, geometry)) hits.push(id);
  }
  for (const shape of layout.shapes) {
    if (rectsIntersect(rect, shapeBounds(shape))) hits.push(shape.id);
  }
  for (const stroke of layout.strokes) {
    const bounds = strokeBounds(stroke.points);
    if (bounds !== null && rectsIntersect(rect, bounds)) hits.push(stroke.id);
  }
  return hits;
}

/**
 * Eraser hit-test: shape/stroke ids whose geometry passes within `radius`
 * world units of the point — a stroke hits when any of its segments comes
 * near the point (cheap bounding-box prefilter, then segment distance);
 * a shape hits when the point sits inside its bounds grown by the radius.
 * Cards are geometry-layout keyed; the eraser only touches shapes/strokes
 * (cards delete through their own chrome, the model law for content).
 */
export function eraserHit(
  layout: WhiteboardLayout,
  point: { x: number; y: number },
  radius: number,
): { shapeIds: string[]; strokeIds: string[] } {
  const shapeIds: string[] = [];
  const strokeIds: string[] = [];
  for (const shape of layout.shapes) {
    const bounds = shapeBounds(shape);
    if (
      point.x >= bounds.x - radius &&
      point.x <= bounds.x + bounds.w + radius &&
      point.y >= bounds.y - radius &&
      point.y <= bounds.y + bounds.h + radius
    ) {
      shapeIds.push(shape.id);
    }
  }
  for (const stroke of layout.strokes) {
    const points = stroke.points;
    for (let i = 0; i + 3 < points.length; i += 2) {
      if (segmentDistance(points[i]!, points[i + 1]!, points[i + 2]!, points[i + 3]!, point.x, point.y) <= radius) {
        strokeIds.push(stroke.id);
        break;
      }
    }
  }
  return { shapeIds, strokeIds };
}

/** Distance from point (px, py) to the segment (x1,y1)-(x2,y2). */
function segmentDistance(x1: number, y1: number, x2: number, y2: number, px: number, py: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Alignment/distribution operate on positioned boxes: cards and shapes. */
export interface PositionedBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type AlignMode = "left" | "centerX" | "right" | "top" | "centerY" | "bottom";

export type DistributeMode = "horizontal" | "vertical";

export const ALIGN_MODES: readonly { mode: AlignMode; label: string }[] = [
  { mode: "left", label: "Align left" },
  { mode: "centerX", label: "Align centers horizontally" },
  { mode: "right", label: "Align right" },
  { mode: "top", label: "Align top" },
  { mode: "centerY", label: "Align centers vertically" },
  { mode: "bottom", label: "Align bottom" },
];

/**
 * New x/y for every box after alignment. The reference line is the
 * min/average/max edge (or center) across all boxes; each box keeps its
 * size. Requires at least two boxes (caller gates on selection size).
 */
export function alignBoxes(
  boxes: readonly PositionedBox[],
  mode: AlignMode,
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  if (boxes.length < 2) return result;
  const left = Math.min(...boxes.map((b) => b.x));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const top = Math.min(...boxes.map((b) => b.y));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  for (const box of boxes) {
    let x = box.x;
    let y = box.y;
    switch (mode) {
      case "left":
        x = left;
        break;
      case "centerX":
        x = left + (right - left) / 2 - box.w / 2;
        break;
      case "right":
        x = right - box.w;
        break;
      case "top":
        y = top;
        break;
      case "centerY":
        y = top + (bottom - top) / 2 - box.h / 2;
        break;
      case "bottom":
        y = bottom - box.h;
        break;
    }
    result.set(box.id, { x, y });
  }
  return result;
}

/**
 * New positions with equal gaps between boxes along the axis, preserving the
 * current span (first/last stay put). Requires at least three boxes.
 */
export function distributeBoxes(
  boxes: readonly PositionedBox[],
  mode: DistributeMode,
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  if (boxes.length < 3) return result;
  const horizontal = mode === "horizontal";
  const sorted = [...boxes].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const span = horizontal ? last.x + last.w - first.x : last.y + last.h - first.y;
  const totalSize = sorted.reduce((sum, b) => sum + (horizontal ? b.w : b.h), 0);
  const gap = (span - totalSize) / (sorted.length - 1);
  let cursor = horizontal ? first.x : first.y;
  for (const box of sorted) {
    if (horizontal) {
      result.set(box.id, { x: cursor, y: box.y });
      cursor += box.w + gap;
    } else {
      result.set(box.id, { x: box.x, y: cursor });
      cursor += box.h + gap;
    }
  }
  return result;
}

/**
 * Connector anchor points: edge midpoints + center of every card and shape
 * on the canvas. The connector tool snaps a drag endpoint to the nearest
 * anchor within `radius` world units (point-in-time snap — the connector
 * stays plain geometry, it does not track the element afterwards).
 */
export function anchorPoints(
  layout: WhiteboardLayout,
  renderedCardIds: readonly string[],
): { x: number; y: number }[] {
  const anchors: { x: number; y: number }[] = [];
  for (const id of renderedCardIds) {
    const geometry = layout.cards[id];
    if (geometry === undefined) continue;
    anchors.push(
      { x: geometry.x + geometry.w / 2, y: geometry.y },
      { x: geometry.x + geometry.w, y: geometry.y + geometry.h / 2 },
      { x: geometry.x + geometry.w / 2, y: geometry.y + geometry.h },
      { x: geometry.x, y: geometry.y + geometry.h / 2 },
      { x: geometry.x + geometry.w / 2, y: geometry.y + geometry.h / 2 },
    );
  }
  for (const shape of layout.shapes) {
    const b = shapeBounds(shape);
    anchors.push(
      { x: b.x + b.w / 2, y: b.y },
      { x: b.x + b.w, y: b.y + b.h / 2 },
      { x: b.x + b.w / 2, y: b.y + b.h },
      { x: b.x, y: b.y + b.h / 2 },
    );
  }
  return anchors;
}

export function snapToAnchor(
  point: { x: number; y: number },
  anchors: readonly { x: number; y: number }[],
  radius: number,
): { x: number; y: number } {
  let best: { x: number; y: number } | null = null;
  let bestDist = radius;
  for (const anchor of anchors) {
    const dist = Math.hypot(anchor.x - point.x, anchor.y - point.y);
    if (dist <= bestDist) {
      best = anchor;
      bestDist = dist;
    }
  }
  return best ?? point;
}
