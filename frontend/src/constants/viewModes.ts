/**
 * View Mode Constants
 * 
 * Centralized constants for view modes across the application.
 * Ensures consistent ordering and icons everywhere.
 */
import { 
  mdiFormatListBulleted, 
  mdiFileDocumentOutline, 
  mdiViewGrid, 
  mdiTable, 
  mdiChartGantt, 
  mdiGraphOutline,
  mdiTerrain,
  mdiTimelineClockOutline,
} from '@mdi/js';
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
  'terrain',
  'timeline'
];

/**
 * View mode icon mappings
 */
export const VIEW_MODE_ICONS: Record<NodeCollectionViewMode, string> = {
  list: mdiFormatListBulleted,
  document: mdiFileDocumentOutline,
  card: mdiViewGrid,
  table: mdiTable,
  gantt: mdiChartGantt,
  graph: mdiGraphOutline,
  terrain: mdiTerrain,
  timeline: mdiTimelineClockOutline,
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
  terrain: 'Terrain',
  timeline: 'Timeline',
};
