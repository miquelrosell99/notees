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
export { ClassView, ClassViewContent, ClassViewWrapper } from './pages/ClassView';
export { NodeCollectionView } from './pages/NodeCollectionView';
export { PagesView } from './pages/PagesView';
export { ClassesView } from './pages/ClassesView';
export { ArchivedPagesView } from './pages/ArchivedPagesView';
export { TrashView } from './pages/TrashView';
export { AllPagesView } from './pages/AllPagesView';
export { TemplateGallery } from './pages/TemplateGallery';
export { AllPagesGraphView } from './pages/AllPagesGraphView';
export { AllPagesTimelineView } from './pages/AllPagesTimelineView';

// Node collections & rendering
export { NodeCollection } from './components/nodes/NodeCollection';
export { NodeCollectionToolbar } from './components/nodes/NodeCollectionToolbar';
export { NodeResultItem } from './components/nodes/NodeResultItem';
export { NodeInline } from './components/blocks/NodeInline';
export { NodeNameContent } from './components/blocks/NodeNameContent';
export { NodeRef } from './components/nodes/NodeRef';
export { NodeBreadcrumbs } from './components/nodes/NodeBreadcrumbs';
export { NodeSelector } from './components/nodes/NodeSelector';
export { SuggestionPopup } from './components/nodes/SuggestionPopup';
export { NodeSearchBox } from './components/nodes/NodeSearchBox';
export { NodeCellEditable } from './components/nodes/NodeCellEditable';
export { AssetImage, type AssetImageVariant } from './components/nodes/AssetImage';
export { PageHeader } from './components/nodes/PageHeader';
export { QuerySection, type QuerySectionProps } from './components/nodes/QuerySection';
export { CollapsiblePillRow } from './components/nodes/CollapsiblePillRow';
export { ConvertToPageModal } from './components/nodes/ConvertToPageModal';
export { ConvertToBlockModal } from './components/nodes/ConvertToBlockModal';

// Block editor
export { BlockList } from './components/blocks/BlockList';
export { BlockRow } from './components/blocks/BlockRow';
export { Bullet } from './components/blocks/Bullet';
// Context menus
export { PageContextMenu, BlockContextMenu, NodeContextMenu } from './components/nodes/NodeContextMenu';
export {
  NodeLinkContextMenu,
  type NodeLinkContextMenuProps,
  type NodeLinkContextMenuRefType,
} from './components/nodes/NodeLinkContextMenu';
export { NodeLinkContextMenuTrigger } from './components/nodes/NodeLinkContextMenuTrigger';



// Presentation
export { PresentationModal } from './components/PresentationModal';

// Calendar / date pickers
export { CalendarPopup } from './components/CalendarPopup';
export { DatePickerPopup } from './components/DatePickerPopup';

// Node sections
export { NodeViewSection } from './components/nodes/NodeViewSection';
export { NodeActivityLogSection } from './components/nodes/NodeActivityLogSection';
export { PageViewHeader } from './components/nodes/PageViewHeader';

// Node collection context
export {
  NodeCollectionContext,
  useNodeCollectionContext,
} from './components/nodes/NodeCollectionContext';

// Hooks consumed by other features
export * from './hooks/useNodes';
export * from './hooks/useNodeSearch';
export * from './hooks/useFavorites';
export * from './hooks/useRecents';
export * from './hooks/useNodeDisplay';
export * from './hooks/usePageClass';
export * from './hooks/useCurrentNodeUuid';
export * from './hooks/useNodeViews';
export { nodeViewKeys } from './hooks/useNodeViews.queries';
export * from './hooks/useComments';
export { extractImageFromDragEvent } from './hooks/useDragDropImage';
export * from './hooks/useLinkedReferencesCount';
export * from './hooks/useResolvedClassDetails';
export * from './hooks/useNodeNavigation';
export * from './hooks/useLivePageSync';
export * from './hooks/useTrash';
export * from './hooks/useArchivedPages';
export * from './hooks/usePageAliases';
export * from './hooks/useBatchNodesByUuid';
export * from './hooks/useTemplates';
export * from './hooks/useConvertNode';
export * from './hooks/useCoreBlockMutations';
export {
  getOrCreateDailyNoteClient,
  getOrCreateMonthlyNoteClient,
  getOrCreateYearlyNoteClient,
} from './hooks/useNodeDateQueries';
export { getNodeUuidByServerId } from './hooks/useNodeMutations.utils';
export * from './hooks/dnd';

// Activity API (moved from src/api)
export * from './api/activity';

// Contexts (moved from src/contexts)
export { ReferencedNodesProvider } from './contexts/ReferencedNodesProvider';
export { ReferencedNodesContext, type ReferencedNodesMap } from './contexts/ReferencedNodesContext';
export { useReferencedNode } from './contexts/useReferencedNode';
export { BrokenLinkFixContext, useBrokenLinkFix, type FixBrokenLinkCallback } from './contexts/BrokenLinkFixContext';


