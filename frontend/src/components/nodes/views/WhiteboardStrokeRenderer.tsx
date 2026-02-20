/**
 * WhiteboardStrokeRenderer — Renders freehand strokes as SVG paths with pressure-based width.
 *
 * Uses Ramer-Douglas-Peucker simplification, average-point smoothing, and cubic
 * Bézier splines (Catmull-Rom conversion) to produce smooth, efficient curves.
 * Supports stylus pressure data from PointerEvent.
 */
import React, { useMemo } from 'react';
import type { WhiteboardStrokeElement, StrokePoint } from '@/types/whiteboard';

/**
 * Maximum deviation (in canvas pixels) allowed when simplifying a stroke.
 * Points that deviate less than this from the straight line between their
 * neighbours are dropped.  Lower = more detail retained; higher = fewer points.
 */
const SIMPLIFICATION_EPSILON = 1.5;

interface Props {
  element: WhiteboardStrokeElement;
  isAbsolute?: boolean; // If true, points are in absolute canvas coords (for current stroke)
  isSelected?: boolean;
  dimmed?: boolean; // Dim when another element is selected
}

/**
 * Ramer-Douglas-Peucker stroke simplification.
 * Keeps only the points that deviate more than `epsilon` canvas pixels from
 * the straight line connecting the current sub-range endpoints.
 * Pressure values are preserved on retained points.
 */
function simplifyPoints(points: StrokePoint[], epsilon = SIMPLIFICATION_EPSILON): StrokePoint[] {
  if (points.length <= 2) return points;

  // Find the point with maximum perpendicular distance from the line [first, last]
  const first = points[0];
  const last = points[points.length - 1];
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const lineLen = Math.sqrt(dx * dx + dy * dy);

  let maxDist = 0;
  let maxIdx = 0;

  if (lineLen === 0) {
    // All points on the same spot — keep only first and last
    for (let i = 1; i < points.length - 1; i++) {
      const d = Math.sqrt((points[i].x - first.x) ** 2 + (points[i].y - first.y) ** 2);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
  } else {
    for (let i = 1; i < points.length - 1; i++) {
      // Perpendicular distance from point i to line (first → last)
      const d = Math.abs(dy * points[i].x - dx * points[i].y + last.x * first.y - last.y * first.x) / lineLen;
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
  }

  if (maxDist > epsilon) {
    // Recursively simplify both halves, keeping the pivot
    const left = simplifyPoints(points.slice(0, maxIdx + 1), epsilon);
    const right = simplifyPoints(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }

  // All intermediate points are within tolerance — discard them
  return [first, last];
}

/**
 * Build a smooth SVG path through an array of {x, y} points using cubic
 * Bézier curves derived from the Catmull-Rom spline formula.
 * Adjacent segments share tangent directions, so the path is C1-continuous.
 */
function pointsToSplinePath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return '';
  if (pts.length === 2) {
    return `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)} L ${pts[1].x.toFixed(1)} ${pts[1].y.toFixed(1)}`;
  }

  const parts: string[] = [`M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`];

  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];

    // Catmull-Rom → cubic Bézier control points (tension = 1/6)
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;

    parts.push(
      `C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)} ${cp2x.toFixed(1)} ${cp2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`
    );
  }

  return parts.join(' ');
}

/**
 * Smooth center-line path for completed strokes.
 * Applies RDP simplification then Catmull-Rom splines.
 * (No smoothing pass — smoothPoints combined with splines over-distorts the shape.)
 */
function strokeToCenterLine(points: StrokePoint[], offsetX = 0, offsetY = 0): string {
  if (points.length < 2) return '';
  const simplified = simplifyPoints(points);
  const pts = simplified.map(p => ({ x: p.x + offsetX, y: p.y + offsetY }));
  return pointsToSplinePath(pts);
}

/**
 * Forward-only quadratic midpoint path for the live (in-progress) stroke.
 * Exported so WhiteboardCanvas can call it imperatively (no React re-render during drawing).
 *
 * Each segment is a quadratic Bézier: control point = current raw point,
 * endpoint = midpoint between current and next point. Because this algorithm
 * never looks ahead, adding a new point only appends a new segment and never
 * reshapes any previously drawn segment — eliminating the "wiggle" effect.
 */
export function strokeToLivePath(points: StrokePoint[], offsetX = 0, offsetY = 0): string {
  if (points.length < 2) return '';

  const ox = offsetX, oy = offsetY;
  const p0 = points[0];
  const parts: string[] = [`M ${(p0.x + ox).toFixed(1)} ${(p0.y + oy).toFixed(1)}`];

  for (let i = 0; i < points.length - 1; i++) {
    const cur = points[i];
    const nxt = points[i + 1];
    const mx = (cur.x + nxt.x) / 2 + ox;
    const my = (cur.y + nxt.y) / 2 + oy;
    parts.push(`Q ${(cur.x + ox).toFixed(1)} ${(cur.y + oy).toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`);
  }

  // End exactly at the last point
  const last = points[points.length - 1];
  parts.push(`L ${(last.x + ox).toFixed(1)} ${(last.y + oy).toFixed(1)}`);

  return parts.join(' ');
}

export const WhiteboardStrokeRenderer: React.FC<Props> = ({ element, isAbsolute, isSelected, dimmed }) => {
  const { points, color, strokeWidth, strokeStyle, opacity } = element;
  const effectiveOpacity = dimmed ? opacity * 0.35 : isSelected ? 1 : opacity;
  const offsetX = isAbsolute ? 0 : element.x;
  const offsetY = isAbsolute ? 0 : element.y;

  const pathData = useMemo(() => {
    if (points.length < 2) return '';
    // Live stroke: forward-only quadratic to prevent retroactive reshaping (wiggle).
    // Completed stroke: full simplify + smooth + Catmull-Rom for best quality.
    return isAbsolute
      ? strokeToLivePath(points, offsetX, offsetY)
      : strokeToCenterLine(points, offsetX, offsetY);
  }, [points, offsetX, offsetY, isAbsolute]);

  if (!pathData) return null;

  const pathEl = (
    <path
      d={pathData}
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      opacity={effectiveOpacity}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={strokeStyle === 'dashed' ? 'wb-ss-dashed' : strokeStyle === 'dotted' ? 'wb-ss-dotted' : undefined}
    />
  );

  return (
    <g style={{ transition: 'opacity var(--motion-duration-medium) var(--motion-easing-standard)' }}>{pathEl}</g>
  );
};
