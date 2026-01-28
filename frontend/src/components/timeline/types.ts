/**
 * Types for Timeline View
 */
import type { Node } from '@/types';

export type ZoomLevel = 'decade' | 'year' | 'quarter' | 'month' | 'week' | 'day' | 'hour';
export type DateProperty = 'create_date' | 'write_date' | 'open_date';

export interface DatePropertyConfig {
  property: string;
  label: string;
  color: string;
  visible: boolean;
  removable: boolean;
}

export interface TimeEvent {
  id: string;                 // Unique identifier
  timePeriod: string;         // Day/month identifier (YYYYMMDD or YYYYMM00)
  timePeriodDate: Date;       // Start date of time period
  property: string;           // Date property name (create_date, write_date, etc.)
  propertyLabel: string;      // Display label
  color: string;              // Color for this property
  nodes: Node[];              // Pages with this property in this time period
  position: number;           // 0-1 normalized position on timeline
  stackIndex: number;         // Vertical stacking order (0 = closest to line)
}

export interface TimelineTransform {
  panX: number;        // Horizontal pan offset
  scale: number;       // Zoom level (continuous)
}

export interface NodeTimelineRendererProps {
  nodes: Node[];
  className?: string;
}
