/**
 * Zoom Level Utilities
 * 
 * Maps scale values to zoom level granularity.
 */
import type { ZoomLevel } from '../timelineTypes';

export function getZoomLevelFromScale(scale: number): ZoomLevel {
  if (scale >= 8.0) return 'hour';
  if (scale >= 4.0) return 'day';
  if (scale >= 2.0) return 'week';
  if (scale >= 1.0) return 'month';
  if (scale >= 0.5) return 'quarter';
  if (scale >= 0.2) return 'year';
  return 'decade';
}
