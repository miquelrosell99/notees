/**
 * View Mode Constants
 * 
 * Centralized constants for view modes across the application.
 * Ensures consistent ordering and icons everywhere.
 */
import type { NodeCollectionViewMode } from '@/types/nodeCollection';

/**
 * Default order for view modes across all NodeCollections
 * This determines the display order in view mode selectors
 */
export const DEFAULT_VIEW_MODES_ORDER: NodeCollectionViewMode[] = [
  'list',
  'table', 
  'card',
  'document',
  'gantt',
  'graph',
  'timeline'
];

/**
 * View mode icon mappings
 */
export const VIEW_MODE_ICONS: Record<NodeCollectionViewMode, string> = {
  list: "mdi mdi-format-list-bulleted",
  document: "mdi mdi-file-document-outline",
  card: "mdi mdi-view-grid",
  table: "mdi mdi-table",
  gantt: "mdi mdi-chart-gantt",
  graph: "mdi mdi-graph-outline",
  timeline: "mdi mdi-timeline-clock-outline",
};

/**
 * View mode labels
 */
export const VIEW_MODE_LABELS: Record<NodeCollectionViewMode, string> = {
  list: 'List',
  document: 'Document',
  card: 'Cards',
  table: 'Table',
  gantt: 'Gantt',
  graph: 'Graph',
  timeline: 'Timeline',
};
