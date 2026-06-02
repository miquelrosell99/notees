/**
 * Node Components Index
 *
 * Node-related components for displaying, editing, and navigating nodes.
 */

export { NodeActivityLogSection } from './NodeActivityLogSection';
export type { NodeActivity } from '@/api/activity';

export { NodeBreadcrumbs } from './NodeBreadcrumbs';
export type { BreadcrumbItem } from './NodeBreadcrumbs';

export { NodeContent } from './NodeContent';

export { NodeContextMenu, PageContextMenu, BlockContextMenu, ColorPickerRow } from './NodeContextMenu';

export { NodeViewSection } from './NodeViewSection';
export type { NodeViewSectionProps } from './NodeViewSection';

export { QueryNodeCollection } from './QueryNodeCollection';
export type { QueryNodeCollectionProps, QueryNodeCollectionResult } from './QueryNodeCollection';

export { QuerySection } from './QuerySection';
export type { QuerySectionProps } from './QuerySection';

export { NodeCollection } from './NodeCollection';
export { useNodeCollectionContext } from './NodeCollectionContext';
export type { NodeCollectionProps, NodeCollectionViewMode } from './NodeCollection';
export { getViewModeOptions } from './views';

export { NodeCollectionToolbar } from './NodeCollectionToolbar';
export { NodeMetadataSection } from './NodeMetadataSection';
export { PageHeader } from './PageHeader';
export { NodeRef } from './NodeRef';
export { NodeResultItem } from './NodeResultItem';
export { NodeSelector } from './NodeSelector';
export { SuggestionPopup } from './SuggestionPopup';
export type { SuggestionPopupProps, SuggestionType } from './SuggestionPopup';
export { ASTViewerModal } from './ASTViewerModal';
export { ImageNode } from './ImageNode';
export { PropertyReferencesSection } from './PropertyReferencesSection';
export { NodeCellEditable } from './NodeCellEditable';
export { ArchivedNodeContextMenu } from './ArchivedNodeContextMenu';
export { TrashNodeContextMenu } from './TrashNodeContextMenu';

// NodeCollection view mode components
export {
  ListView,
  DocumentView,
  CardView,
  TableView,
  GanttView,
  GraphView,
  TimelineView,
  WhiteboardView,
} from './views';
export type { GraphViewProps } from './views';
