/**
 * Components module - exports all components
 */

// Layout components
export { Layout } from './Layout';
export { TopBar } from './TopBar';
export { Sidebar } from './Sidebar';
export { MainContent } from './MainContent';

// Auth components
export { LoginPage } from '../views/LoginPage';

// Page components
export { NodeView } from '../views/NodeView';
export { DailyPage } from './DailyPage';
export { ArchivedView } from '../views/ArchivedView';

// Node components (from nodes/ folder)
export { NodeBreadcrumbs } from './nodes/NodeBreadcrumbs';
export type { BreadcrumbItem } from './nodes/NodeBreadcrumbs';
export { PageHeader } from './PageHeader';
export { NodeContent } from './nodes/NodeContent';
export { NodeContextMenu, PageContextMenu, BlockContextMenu } from './nodes/NodeContextMenu';

// Block components (from blocks/ folder)
export { Block } from './blocks/Block';
export { BlockEditor, TASK_STATES } from './blocks/BlockEditor';
export type { TaskState } from './blocks/BlockEditor';
export { BlockContent } from './blocks/BlockContent';
export { BlockPreview } from './blocks/BlockPreview';
export type { BlockPreviewProps, BlockPreviewVariant, BlockPreviewSize } from './blocks/BlockPreview';
export { BlockPreviewDrag } from './blocks/BlockPreviewDrag';
export type { BlockPreviewDragProps, BlockPreviewDragVariant } from './blocks/BlockPreviewDrag';
export { Bullet } from './blocks/Bullet';
export type { BulletProps, BulletSize, BulletVariant } from './blocks/Bullet';
export { ImageBlock } from './blocks/ImageBlock';
export { TextPropertyBlock } from './blocks/TextPropertyBlock';

// Core UI components
export { BoxSelect } from './core/BoxSelect';
export { SuggestionPopup } from './SuggestionPopup';
export type { SuggestionPopupProps, SuggestionType } from './SuggestionPopup';
export { SlashCommandPopup } from './core/SlashCommandPopup';
export type { SlashCommandPopupProps, SlashCommand } from './core/SlashCommandPopup';

// List components
export { TagList, TaggedNodes } from './TagList';

// Linked references
export { LinkedReferences, References, useLinkedReferencesCount } from './LinkedReferences';
export { NodeViewSection } from './nodes/NodeViewSection';
export type { NodeViewSectionProps } from './nodes/NodeViewSection';
export { 
  ReferencesView, 
  LinkedReferencesList, 
  LinkedReferencesTable,
  linkedReferenceToItem,
  propertyBacklinkToPageItem,
} from '../views/ReferencesView';
export type { ReferenceItem, PageReferenceItem, ReferenceViewMode } from '../views/ReferencesView';

// Properties (from properties/ folder)
export { PropertiesSection, InlineProperties } from './PropertiesSection';
export { NodePicker } from './nodes/NodePicker';
export { TypeExtendsEditor } from './TypeExtendsEditor';
export { TypePropertiesEditor } from './TypePropertiesEditor';
export { TypedNodesView } from './TypedNodesSection';
export { ChildPagesSection } from './ChildPagesSection';
export { PagesTree } from './PagesTree';
export type { PagesTreeProps } from './PagesTree';
export { PropertyConfigPanel } from './properties/PropertyConfigPanel';
export { PropertyPickerModal } from './properties/PropertyPickerModal';
export { PropertyCreateModal } from './properties/PropertyCreateModal';
export { PropertyList } from './properties/PropertyList';
export type { PropertyListProps, PropertyEntry } from './properties/PropertyList';
export { PropertyView } from '../views/PropertyView';

// UI components
export { Button } from './core/Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './core/Button';
export { ButtonWithPanel } from './core/ButtonWithPanel';
export type { ButtonWithPanelProps, PanelPosition, PanelAlignment } from './core/ButtonWithPanel';
export { Card, Panel } from './core/Card';
export type { CardProps, CardElevation, CardVariant, PanelProps, PanelElevation } from './core/Card';
export { SearchBox } from './SearchBox';
export { CalendarPopup } from './core/CalendarPopup';
export { QuickAddDialog } from './QuickAddDialog';
export { QuickAddPanel } from './QuickAddPanel';
export { SidebarCard } from './SidebarCard';
export { CommandPalette } from './CommandPalette';
export type { CommandPaletteProps } from './CommandPalette';

// New core components
export { Separator } from './core/Separator';
export type { SeparatorProps, SeparatorOrientation, SeparatorSize } from './core/Separator';
export { Checkbox } from './core/Checkbox';
export type { CheckboxProps, CheckboxSize } from './core/Checkbox';
export { BooleanToggle } from './core/BooleanToggle';
export type { BooleanToggleProps, BooleanToggleSize } from './core/BooleanToggle';
export { Table } from './core/Table';
export type { TableProps, TableColumn, TableSize, TableVariant, SortDirection } from './core/Table';
export { Dropdown } from './core/Dropdown';
export type { DropdownProps, DropdownOption, DropdownSize } from './core/Dropdown';

// Graph components (domain-specific)
export { 
  NodeToNodeLine, 
  drawNodeToNodeLine, 
  NodeCircle, 
  drawNodeCircle,
  NodeGraphRenderer,
  NodeGraphView,
  NodeGraphViewSimple,
  GraphViewAll,
  GraphViewAllCard,
  GraphViewLocal,
} from './graph';
export type { 
  NodeToNodeLineProps, 
  LineStyle, 
  ArrowDirection,
  NodeCircleProps, 
  NodeCircleState,
  NodeGraphRendererRef,
  GraphNode,
  GraphLink,
  NodeGraphViewProps,
  NodeGraphViewSimpleProps,
  GraphViewAllProps,
  GraphViewAllCardProps,
  GraphViewLocalProps,
} from './graph';

// View components
export { AllPagesView } from '../views/AllPagesView';
export { JournalsView } from '../views/JournalsView';
export { SidebarNodeView } from './SidebarNodeView';
export { CommentsSidebar } from './CommentsSidebar';
export { CalendarView } from '../views/CalendarView';
export type { CalendarViewProps } from '../views/CalendarView';
export { ChartView } from '../views/ChartView';
export type { ChartViewProps } from '../views/ChartView';
export { GanttView } from '../views/GanttView';
export type { GanttViewProps } from '../views/GanttView';
export { QueryView } from '../views/QueryView';
export type { QueryViewProps } from '../views/QueryView';
export { PropertyNodesView } from './PropertyNodesView';
export type { PropertyNodesViewProps, PropertyViewMode } from './PropertyNodesView';
export { TemplateUsedInView } from './TemplateUsedInView';

// Modal components
export { Modal } from './core/Modal';
export type { ModalProps, ModalSize } from './core/Modal';
export { SettingsModal } from './SettingsModal';
export { ConfirmationModal } from './core/ConfirmationModal';
export { DatabaseModal } from './databases/DatabaseModal';
export { DatabaseNameModal } from './databases/DatabaseNameModal';
export { ImportOptionsModal } from './ImportOptionsModal';
export { DatabaseSwitcher } from './databases/DatabaseSwitcher';
export { DatabaseManagementView } from '../views/DatabaseManagementView';
export { AssetUploadModal } from './assets/AssetUploadModal';

// Asset components
export { AssetPreview } from './assets/AssetPreview';
export { AssetBlock } from './assets/AssetBlock';
export { AssetsView } from '../views/AssetsView';

// Emoji/Icon picker
export { EmojiPicker, EmojiPickerTrigger } from './core/EmojiPicker';

// Color picker
export { ColorPicker, ColorSwatch } from './core/ColorPicker';

// Context menu
export { ContextMenu } from './core/ContextMenu';
export type { ContextMenuItem } from './core/ContextMenu';

// Scratchpad
export { Scratchpad } from './Scratchpad';

// Node preview (transclusion)
export { NodePreview } from './nodes/NodePreview';

// Activity log
export { NodeActivityLog } from './nodes/NodeActivityLog';
export type { NodeActivity } from './nodes/NodeActivityLog';

// Banner and Cover images
export { BannerImage } from './BannerImage';
export { CoverImage } from './CoverImage';

// Node link components
export { NodeLink } from './nodes/NodeLink';
export type { NodeLinkProps } from './nodes/NodeLink';
export { NodeLinkSearch } from './nodes/NodeLinkSearch';
export type { NodeLinkSearchProps, LinkSearchType } from './nodes/NodeLinkSearch';

// NodeCollection - Universal node collection system
export { NodeCollection, useNodeCollectionContext, getViewModeOptions } from './nodes/NodeCollection';
export type { NodeCollectionProps, NodeCollectionViewMode } from './nodes/NodeCollection';

// NodeCollection view mode components
export { NodeListView } from './nodes/views/NodeListView';
export { NodeDocumentView } from './nodes/views/NodeDocumentView';
export { NodeCardView } from './nodes/views/NodeCardView';
export { NodeCard } from './nodes/views/NodeCard';
export type { NodeCardProps } from './nodes/views/NodeCard';
export { NodeTableView } from './nodes/views/NodeTableView';
export { NodeGanttView } from './nodes/views/NodeGanttView';

// Icons
export * from './icons';
