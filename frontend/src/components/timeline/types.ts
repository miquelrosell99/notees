/**
 * Types for Timeline View
 */
import type { Node } from '@/types';

export type ZoomLevel = 'decade' | 'year' | 'quarter' | 'month' | 'week' | 'day' | 'hour';
export type DateProperty = 'create_date' | 'write_date' | 'open_date';

export interface TimelineNode {
  id: number;
  x: number;           // Horizontal position (pixels)
  y: number;           // Vertical position (pixels)
  vx: number;          // Horizontal velocity
  vy: number;          // Vertical velocity
  date: Date;          // Node's timestamp
  node: Node;          // Reference to original node
  radius: number;
  color: string;
  laneIndex: number;   // Assigned vertical lane
  targetY: number;     // Target vertical position
  gravityPointId: string; // Which gravity point this belongs to
}

export interface GravityPoint {
  id: string;
  position: number;    // 0-1 along timeline (normalized)
  x: number;           // Pixel position (calculated from position)
  startTime: Date;
  endTime: Date;
  label: string;
  nodes: TimelineNode[]; // Nodes within this time range
  hasPage: boolean;    // Whether a journal page exists for this time
  uuid?: string;       // Journal page UUID
}

export interface TypeColor {
  typeId: number;
  typeName: string;
  color: string;
  order: number;
}

export interface TimelineTransform {
  panX: number;        // Horizontal pan offset
  scale: number;       // Zoom level (continuous)
}

export interface NodeTimelineRendererProps {
  nodes: Node[];
  dateProperty?: DateProperty;
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
  className?: string;
}
