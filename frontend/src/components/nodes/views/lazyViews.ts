/**
 * Lazy View Registrations
 *
 * Registers metadata for heavy views eagerly so the toolbar and switcher
 * can display icons/labels immediately. The actual components are lazy-loaded
 * via React.lazy to keep the initial bundle small.
 */
import { lazy } from 'react';
import { registerView } from './registry';

// Eagerly load light views
import './ListView';
import './DocumentView';
import './CardView';
import './TableView';
import './KanbanView';

// Lazy-load heavy views (wrap named export into default for React.lazy)
const GanttView = lazy(() => import('./GanttView').then((m) => ({ default: m.GanttView })));
const GraphView = lazy(() => import('./GraphView').then((m) => ({ default: m.GraphView })));
const TimelineView = lazy(() => import('./TimelineView').then((m) => ({ default: m.TimelineView })));

registerView({
  id: 'gantt',
  label: 'Gantt',
  icon: 'mdi mdi-chart-gantt',
  component: GanttView,
  capabilities: { groupBy: true, ganttConfig: true },
});

registerView({
  id: 'graph',
  label: 'Graph',
  icon: 'mdi mdi-graph-outline',
  component: GraphView,
  capabilities: { errorBoundary: true, containerCard: true },
});

registerView({
  id: 'timeline',
  label: 'Timeline',
  icon: 'mdi mdi-timeline-clock-outline',
  component: TimelineView,
  capabilities: { errorBoundary: true },
});
