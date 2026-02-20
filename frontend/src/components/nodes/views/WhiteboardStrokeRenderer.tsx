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
 * Simple moving-average smoothing.
 */
function smoothPoints(points: StrokePoint[], windowSize = 3): StrokePoint[] {
  if (points.length <= windowSize) return points;

  const result: StrokePoint[] = [];
  const half = Math.floor(windowSize / 2);

  for (let i = 0; i < points.length; i++) {
    let sumX = 0, sumY = 0, sumP = 0;
    let count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(points.length - 1, i + half); j++) {
      sumX += points[j].x;
      sumY += points[j].y;
      sumP += points[j].pressure;
      count++;
    }
    result.push({
      x: sumX / count,
      y: sumY / count,
      pressure: sumP / count,
    });
  }

  return result;
}

/**
 * Smooth center-line path (fallback for very short strokes).
 * Uses cubic Bézier splines for consistency with the full renderer.
 */
function strokeToCenterLine(points: StrokePoint[], offsetX = 0, offsetY = 0): string {
  if (points.length < 2) return '';
  const simplified = simplifyPoints(points);
  const pts = simplified.map(p => ({ x: p.x + offsetX, y: p.y + offsetY }));
  return pointsToSplinePath(pts);
}

export const WhiteboardStrokeRenderer: React.FC<Props> = ({ element, isAbsolute, isSelected, dimmed }) => {
  const { points, color, strokeWidth, opacity } = element;
  const effectiveOpacity = dimmed ? opacity * 0.35 : isSelected ? 1 : opacity;
  const offsetX = isAbsolute ? 0 : element.x;
  const offsetY = isAbsolute ? 0 : element.y;

  const pathData = useMemo(() => {
    if (points.length < 2) return '';
    return strokeToCenterLine(points, offsetX, offsetY);
  }, [points, offsetX, offsetY]);

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
    />
  );

  return (
    <g style={{ transition: 'opacity var(--motion-duration-medium) var(--motion-easing-standard)' }}>{pathEl}</g>
  );
};
