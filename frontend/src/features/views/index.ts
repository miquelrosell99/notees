/**
 * Public surface of the views feature.
 *
 * Cross-feature imports should prefer `@/features/views` (this barrel) over
 * reaching into internal subdirectories.
 */

// View mode components
export { ListView } from './components/ListView';
export { DocumentView } from './components/DocumentView';
export { KanbanView } from './components/KanbanView';
export { NodeCard, type NodeCardProps } from './components/KanbanCard';
export { TableView } from './components/TableView';
export { GanttView } from './components/GanttView';
export { GraphView } from './components/GraphView';
export type { GraphViewProps } from './components/GraphView';
export { TimelineView } from './components/TimelineView';
export { CalendarView } from './components/CalendarView';
export { ChartView } from './components/ChartView';
export { PivotView } from './components/PivotView';

// View registry
export {
  registerView,
  getViewDefinition,
  getRegisteredViewModes,
  getViewModeOptions,
} from './components/registry';
export type { ViewRegistryEntry, ViewCapabilities } from './components/registry';

// Graph canvas (physics worker + WebGL2 renderer)
export { GraphRenderer, type GraphRendererRef } from './renderers/GraphRenderer';
export type { GraphRendererProps } from './renderers/GraphRenderer';
export { useGraphRenderer } from './hooks/useGraphRenderer';
export type { GraphRendererOptions, GraphRendererHandle, GraphRendererStats } from './hooks/useGraphRenderer';
export { GraphWebGLRenderer } from './renderers/graphWebGLRenderer';
export type { NodeVisual, RendererOptions, CameraState } from './renderers/graphWebGLRenderer';

// Shared view types and helpers
export * from './types/viewTypes';
export { calculateMaxConnections, getDirectionalConnectionCount } from './utils/viewHelpers';

// View-specific hooks
export { useCalendarData, type CalendarEvent } from './hooks/useCalendarData';
export { useCalendarDateMutation } from './hooks/useCalendarDateMutation';
export { useGanttDateMutation } from './hooks/useGanttDateMutation';
export { useChartAggregate } from './hooks/useChartAggregate';
export { usePivotAggregate } from './hooks/usePivotAggregate';
export { useGanttData } from './hooks/useGanttData';

// Re-export commonly used date utilities from useCalendarData for convenience
export {
  addDays,
  startOfMonth,
  startOfWeek,
  isSameDay,
  isBeforeDay,
  isAfterDay,
} from './hooks/useCalendarData';
