import type { StrokePoint } from '@/types/whiteboard';

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
