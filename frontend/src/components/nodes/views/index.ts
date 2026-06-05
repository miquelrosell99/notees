/**
 * NodeCollection Views Index
 *
 * Exports all view mode components for NodeCollection.
 * Light views are imported eagerly; heavy views are lazy-loaded via lazyViews.ts.
 */

// Eager side-effect registrations (light views)
import './ListView';
import './DocumentView';
import './CardView';
import './TableView';

import './CalendarView';

// Lazy registrations for heavy views (metadata eager, components lazy)
import './lazyViews';

// Re-export components for direct use
export { ListView } from './ListView';
export { DocumentView } from './DocumentView';
export { CardView } from './CardView';
export { NodeCard } from './CardItem';
export type { NodeCardProps } from './CardItem';
export { TableView } from './TableView';
export { GanttView } from './GanttView';
export { GraphView } from './GraphView';
export type { GraphViewProps } from './GraphView';
export { TimelineView } from './TimelineView';
export { WhiteboardView } from './WhiteboardView';

export { CalendarView } from './CalendarView';
export { ChartView } from './ChartView';
export type { NodeChartViewProps } from '@/types/nodeCollection';

// View registry
export {
  registerView,
  getViewDefinition,
  getRegisteredViewModes,
  getViewModeOptions,
} from './registry';
export type { ViewRegistryEntry, ViewCapabilities } from './registry';

// Graph canvas (physics worker + WebGL2 renderer)
export { GraphRenderer, type GraphRendererRef } from './GraphRenderer';
export type { GraphRendererProps } from './GraphRenderer';
export { useGraphRenderer } from './useGraphRenderer';
export type { GraphRendererOptions, GraphRendererHandle, GraphRendererStats } from './useGraphRenderer';
export { GraphWebGLRenderer } from './graphWebGLRenderer';
export type { NodeVisual, RendererOptions, CameraState } from './graphWebGLRenderer';

// Shared view types and helpers
export * from './viewTypes';
export { calculateMaxConnections, getDirectionalConnectionCount } from './viewHelpers';
