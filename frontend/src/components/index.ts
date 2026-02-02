/**
 * Components module - exports all components
 */

// Layout components
export { Layout } from './layout/Layout';
export { TopBar } from './layout/TopBar';
export { Sidebar } from './layout/NavigationSidebar';
export { MainContent } from './layout/MainContent';

// Auth components
export { LoginPage } from '../views/LoginPage';

// Page components
export { NodeView } from '../views/NodeView';

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
export type { BlockPreviewProps } from './blocks/BlockPreview';
export { BlockDrag } from './blocks/BlockDrag';
export type { BlockDragProps } from './blocks/BlockDrag';
export { Bullet } from './blocks/Bullet';
export type { BulletProps, BulletSize, BulletVariant } from './blocks/Bullet';
export { TextPropertyBlock } from './blocks/TextPropertyBlock';

// Core UI components
export { BoxSelect } from './core/BoxSelect';
export { SuggestionPopup } from './SuggestionPopup';
export type { SuggestionPopupProps, SuggestionType } from './SuggestionPopup';
export { SlashCommandPopup } from './SlashCommandPopup';
export type { SlashCommandPopupProps, SlashCommand } from './SlashCommandPopup';

// List components
export { TagList, TaggedNodes } from './TagList';

// Node View Section
export { NodeViewSection } from './nodes/NodeViewSection';
export type { NodeViewSectionProps } from './nodes/NodeViewSection';

// Properties (from properties/ folder)
export { PropertiesSection, InlineProperties } from './PropertiesSection';
export { NodePicker } from './nodes/NodePicker';
export { ClassExtendsEditor } from './ClassExtendsEditor';
export { ClassPropertiesEditor } from './ClassPropertiesEditor';
export { PropertyConfigPanel } from './properties/PropertyConfigPanel';
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
export { QuickAddDialog } from './quickadd/QuickAddDialog';
export { QuickAddPanel } from './quickadd/QuickAddPanel';
export { SidebarCard } from './sidebar/SidebarCard';
export { CommandPalette } from './CommandPalette';
export type { CommandPaletteProps } from './CommandPalette';
export { ImportDataModal } from './ImportDataModal';

// Table block component
export { TableBlock } from './blocks/TableBlock';

// New core components
export { Separator } from './core/Separator';
export type { SeparatorProps, SeparatorOrientation, SeparatorSize } from './core/Separator';
export { Checkbox } from './core/Checkbox';
export type { CheckboxProps, CheckboxSize } from './core/Checkbox';
export { BooleanToggle } from './core/BooleanToggle';
export type { BooleanToggleProps, BooleanToggleSize } from './core/BooleanToggle';
export { Table } from './core/Table';
export type { TableProps, TableColumn, TableSize, TableVariant, SortDirection } from './core/Table';
export { CollapseArrow } from './core/CollapseArrow';
export type { CollapseArrowProps, CollapseArrowSize } from './core/CollapseArrow';
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
export { SidebarNodeView } from './sidebar/SidebarNodeView';
export { CommentsSidebar } from './sidebar/CommentsSidebar';
// CalendarView, ChartView, GanttView, QueryView - not yet implemented
export { PropertyNodesView } from './PropertyNodesView';
export type { PropertyNodesViewProps, PropertyViewMode } from './PropertyNodesView';

// Modal components
export { Modal } from './core/Modal';
export type { ModalProps, ModalSize } from './core/Modal';
export { SettingsModal } from './SettingsModal';
export { ConfirmationModal } from './core/ConfirmationModal';
export { GraphModal } from './graphs/GraphModal';
export { GraphNameModal } from './graphs/GraphNameModal';
export { ImportOptionsModal } from './graphs/ImportOptionsModal';
export { GraphSwitcher } from './graphs/GraphSwitcher';
export { GraphManagementView } from '../views/GraphManagementView';
export { AssetUploadModal } from './assets/AssetUploadModal';

// Asset components
export { AssetPreview } from './assets/AssetPreview';
export { AssetBlock } from './assets/AssetBlock';

// Emoji/Icon picker
export { EmojiPicker, EmojiPickerTrigger } from './core/EmojiPicker';

// Color button
export { ColorButton } from './core/ColorButton';

// Context menu
export { ContextMenu } from './core/ContextMenu';
export type { ContextMenuItem } from './core/ContextMenu';

// Scratchpad
export { Scratchpad } from './Scratchpad';

// Node preview (transclusion)
export { NodePreview } from './nodes/NodePreview';

// Activity log
export { NodeActivityLogSection } from './nodes/NodeActivityLogSection';
export type { NodeActivity } from './nodes/NodeActivityLogSection';

// Banner and Cover images
export { BannerImage } from './BannerImage';
export { CoverImage } from './CoverImage';

// Node link components
export { NodeLink } from './nodes/NodeLink';
export type { NodeLinkProps } from './nodes/NodeLink';

// NodeCollection - Universal node collection system
export { NodeCollection, useNodeCollectionContext, getViewModeOptions } from './nodes/NodeCollection';
export type { NodeCollectionProps, NodeCollectionViewMode } from './nodes/NodeCollection';

// NodeCollection view mode components
export { NodeListView } from './nodes/views/NodeListView';
export { NodeDocumentView } from './nodes/views/NodeDocumentView';
export { NodeCardView } from './nodes/views/NodeCardView';
export { NodeTableView } from './nodes/views/NodeTableView';
export { NodeGanttView } from './nodes/views/NodeGanttView';

// Query builder components
export { ViewBuilder } from './queries';
export { NodeViewTabs } from './NodeViewTabs';
export type { ViewType } from './NodeViewTabs';

// Icons
export * from './icons';
