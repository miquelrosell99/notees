/**
 * Public surface of the content feature.
 *
 * Cross-feature imports should prefer `@/features/content` (this barrel) over
 * reaching into internal subdirectories. Internal content modules may still
 * import each other through deep paths for co-location, but anything consumed
 * by other features (layout, tasks, journals, sidebar, shares, etc.) belongs
 * here.
 */

// Pages / top-level views
export { NodeView, NodeViewContent, NodeViewWrapper } from './pages/NodeView';
export { NodeCollectionView } from './pages/NodeCollectionView';
export { PagesView } from './pages/PagesView';
export { ArchivedPagesView } from './pages/ArchivedPagesView';
export { TrashView } from './pages/TrashView';
export { WhiteboardsView } from './pages/WhiteboardsView';
export { AllPagesView } from './pages/AllPagesView';
export { AllPagesGraphView } from './pages/AllPagesGraphView';
export { AllPagesTimelineView } from './pages/AllPagesTimelineView';
export { PropertyView } from './pages/PropertyView';

// Node collections & rendering
export { NodeCollection } from './components/nodes/NodeCollection';
export { NodeCollectionToolbar } from './components/nodes/NodeCollectionToolbar';
export { NodeInline } from './components/blocks/NodeInline';
export { NodeNameContent } from './components/blocks/NodeNameContent';
export { NodeRef } from './components/nodes/NodeRef';
export { NodeBreadcrumbs } from './components/nodes/NodeBreadcrumbs';
export { NodeSelector } from './components/nodes/NodeSelector';
export { SuggestionPopup } from './components/nodes/SuggestionPopup';
export { NodeSearchBox } from './components/nodes/NodeSearchBox';
export { NodeCellEditable } from './components/nodes/NodeCellEditable';

// Block editor
export { BlockList } from './components/blocks/BlockList';
export { BlockRow } from './components/blocks/BlockRow';
export { Bullet } from './components/blocks/Bullet';

// Context menus
export { PageContextMenu, BlockContextMenu, NodeContextMenu } from './components/nodes/NodeContextMenu';

// Properties
export { PropertiesSection } from './components/properties/PropertiesSection';
export { PropertyCell } from './components/properties/PropertyCell';
export { getPropertyValueRenderer } from './components/properties/propertyValueRegistry';

// Views
export { GraphView } from './components/nodes/views/GraphView';
export { TimelineView } from './components/nodes/views/TimelineView';

// Presentation
export { PresentationModal } from './components/PresentationModal';

// Calendar / date pickers
export { CalendarPopup } from './components/CalendarPopup';

// Node sections
export { NodeViewSection } from './components/nodes/NodeViewSection';

// Hooks consumed by other features
export * from './hooks/useNodes';
export * from './hooks/useNodeSearch';
export * from './hooks/useProperties';
export * from './hooks/useFavorites';
export * from './hooks/useRecents';
export * from './hooks/useNodeDisplay';
export * from './hooks/useContentSave';
export * from './hooks/usePageClass';
export * from './hooks/useListDragSort';
export * from './hooks/useNodeViews';
export * from './hooks/useComments';
export * from './hooks/useLinkedReferencesCount';
export * from './hooks/useResolvedClassDetails';
export * from './hooks/useHierarchicalPath';
export * from './hooks/useNodeNavigation';
export * from './hooks/useLivePageSync';
export * from './hooks/useWhiteboard';
export * from './hooks/useTrash';
export * from './hooks/useArchivedPages';
export * from './hooks/usePageAliases';
export * from './hooks/usePropertySuggestions';
export * from './hooks/useGanttDateMutation';
export * from './hooks/useCalendarData';
export * from './hooks/useCalendarDateMutation';
export * from './hooks/useChartAggregate';
export * from './hooks/usePivotAggregate';
export * from './hooks/useBatchNodes';

// Stores
export { usePresentationStore } from '@/stores/presentationStore';
