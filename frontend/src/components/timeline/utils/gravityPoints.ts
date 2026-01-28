/**
 * Gravity Point Generation
 * 
 * Generates time-based anchor points that nodes cluster around.
 * Adapts granularity based on zoom level.
 */
import type { GravityPoint, ZoomLevel, TimelineNode } from '../types';
import { formatDateUuid, formatDateLabel, getNextInterval, alignToInterval, normalizeDate } from './dateUtils';

const ZOOM_TO_PRECISION: Record<ZoomLevel, 'decade' | 'year' | 'quarter' | 'month' | 'week' | 'day' | 'hour'> = {
  'decade': 'year',
  'year': 'quarter',
  'quarter': 'month',
  'month': 'week',
  'week': 'day',
  'day': 'hour',
  'hour': 'hour', // At hour level, show hourly intervals
};

const ZOOM_UUID_TYPE: Record<ZoomLevel, 'day' | 'month' | 'year'> = {
  'decade': 'year',
  'year': 'year',
  'quarter': 'month',
  'month': 'month',
  'week': 'day',
  'day': 'day',
  'hour': 'day',
};

export function generateGravityPoints(
  startDate: Date,
  endDate: Date,
  zoomLevel: ZoomLevel,
  pageUuidMap: Map<string, any>
): GravityPoint[] {
  const points: GravityPoint[] = [];
  const precision = ZOOM_TO_PRECISION[zoomLevel];
  const uuidType = ZOOM_UUID_TYPE[zoomLevel];
  
  let current = alignToInterval(startDate, precision);
  
  while (current <= endDate) {
    const next = getNextInterval(current, precision);
    const position = normalizeDate(current, startDate, endDate);
    const uuid = formatDateUuid(current, uuidType);
    
    points.push({
      id: `${current.getTime()}`,
      position,
      x: 0, // Will be calculated later with canvas width
      startTime: new Date(current),
      endTime: next,
      label: formatDateLabel(current, precision),
      nodes: [],
      hasPage: pageUuidMap.has(uuid),
      uuid: pageUuidMap.has(uuid) ? uuid : undefined,
    });
    
    current = next;
  }
  
  return points;
}

export function assignNodesToGravityPoints(
  nodes: TimelineNode[],
  gravityPoints: GravityPoint[]
): void {
  // Clear existing assignments
  gravityPoints.forEach(gp => gp.nodes = []);
  
  // Assign each node to nearest gravity point
  for (const node of nodes) {
    let nearestPoint = gravityPoints[0];
    let minDist = Infinity;
    
    for (const gp of gravityPoints) {
      const gpTime = gp.startTime.getTime();
      const nodeTime = node.date.getTime();
      const dist = Math.abs(gpTime - nodeTime);
      
      if (dist < minDist) {
        minDist = dist;
        nearestPoint = gp;
      }
    }
    
    if (nearestPoint) {
      nearestPoint.nodes.push(node);
      node.gravityPointId = nearestPoint.id;
    }
  }
}

export function getZoomLevelFromScale(scale: number): ZoomLevel {
  if (scale >= 8.0) return 'hour';
  if (scale >= 4.0) return 'day';
  if (scale >= 2.0) return 'week';
  if (scale >= 1.0) return 'month';
  if (scale >= 0.5) return 'quarter';
  if (scale >= 0.2) return 'year';
  return 'decade';
}
