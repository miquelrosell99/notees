/**
 * Public surface of the views feature.
 *
 * Cross-feature imports should prefer `@/features/views` (this barrel) over
 * reaching into internal subdirectories.
 */

// Light view mode components (always loaded)
export { ListView } from './components/ListView';
export { DocumentView } from './components/DocumentView';
export { KanbanView } from './components/KanbanView';
export { NodeCard, type NodeCardProps } from './components/KanbanCard';
export { TableView } from './components/TableView';

// Heavy/canvas views are lazy-loaded via the registry below
export {
  GanttView,
  GraphView,
  TimelineView,
  CalendarView,
  ChartView,
  PivotView,
} from './components/lazyViews';
export type { GraphViewProps } from './components/GraphView';

// View registry
export {
  registerView,
  getViewDefinition,
  getRegisteredViewModes,
  getViewModeOptions,
} from './components/registry';
export type { ViewRegistryEntry, ViewCapabilities } from './components/registry';

// Shared view types and helpers
export * from './types/viewTypes';
export { calculateMaxConnections, getDirectionalConnectionCount } from './utils/viewHelpers';
export { evaluateQueryAST, buildEvalContext } from './utils/evaluateQueryAST';
export type { EvalContext } from './utils/evaluateQueryAST';

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
