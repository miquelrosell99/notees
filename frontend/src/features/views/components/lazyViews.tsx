/**
 * Lazy View Registrations
 *
 * Registers metadata for heavy views eagerly so the toolbar and switcher
 * can display icons/labels immediately. The actual components are lazy-loaded
 * via React.lazy to keep the initial bundle small.
 *
 * Public exports are Suspense-wrapped so consumers can use them like normal
 * components without adding their own Suspense boundaries.
 */
/* eslint-disable react-refresh/only-export-components */
import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import { registerView } from './registry';

// Eagerly load light views
import './ListView';
import './DocumentView';
import './KanbanView';
import './TableView';

function withSuspense<T extends object>(
  Component: LazyExoticComponent<ComponentType<T>>
): ComponentType<T> {
  return function LazyViewWrapper(props: T) {
    return (
      <Suspense fallback={<Spinner size="md" centered />}>
        <Component {...props} />
      </Suspense>
    );
  };
}

// Lazy-load heavy canvas/aggregation views
const GanttViewLazy = lazy(() => import('./GanttView').then((m) => ({ default: m.GanttView })));
const GraphViewLazy = lazy(() => import('./GraphView').then((m) => ({ default: m.GraphView })));
const TimelineViewLazy = lazy(() => import('./TimelineView').then((m) => ({ default: m.TimelineView })));
const PivotViewLazy = lazy(() => import('./PivotView').then((m) => ({ default: m.PivotView })));
const CalendarViewLazy = lazy(() => import('./CalendarView').then((m) => ({ default: m.CalendarView })));
const ChartViewLazy = lazy(() => import('./ChartView').then((m) => ({ default: m.ChartView })));

export const GanttView = withSuspense(GanttViewLazy);
export const GraphView = withSuspense(GraphViewLazy);
export const TimelineView = withSuspense(TimelineViewLazy);
export const PivotView = withSuspense(PivotViewLazy);
export const CalendarView = withSuspense(CalendarViewLazy);
export const ChartView = withSuspense(ChartViewLazy);

registerView({
  id: 'gantt',
  label: 'Gantt',
  icon: 'mdi mdi-chart-gantt',
  component: GanttViewLazy,
  capabilities: { groupBy: true, ganttConfig: true },
});

registerView({
  id: 'graph',
  label: 'Graph',
  icon: 'mdi mdi-graph-outline',
  component: GraphViewLazy,
  capabilities: { errorBoundary: true, containerCard: true },
});

registerView({
  id: 'timeline',
  label: 'Timeline',
  icon: 'mdi mdi-timeline-clock-outline',
  component: TimelineViewLazy,
  capabilities: { errorBoundary: true },
});

registerView({
  id: 'pivot',
  label: 'Pivot',
  icon: 'mdi mdi-table-pivot',
  component: PivotViewLazy,
  capabilities: { groupBy: false },
});

registerView({
  id: 'calendar',
  label: 'Calendar',
  icon: 'mdi mdi-calendar-month',
  component: CalendarViewLazy,
  capabilities: { errorBoundary: true },
});

registerView({
  id: 'chart',
  label: 'Chart',
  icon: 'mdi mdi-chart-bar',
  component: ChartViewLazy,
  capabilities: { errorBoundary: true },
});
