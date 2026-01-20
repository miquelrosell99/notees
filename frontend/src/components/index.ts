/**
 * Components module - exports all components
 */

// Layout components
export { Layout } from './Layout';
export { TopBar } from './TopBar';
export { Sidebar } from './Sidebar';
export { MainContent } from './MainContent';

// Auth components
export { LoginPage } from './LoginPage';

// Page components
export { NodeView } from '../views/NodeView';
export { DailyPage } from './DailyPage';
export { ArchivedView } from '../views/ArchivedView';

// Node components (new structure)
export { NodeBreadcrumbs } from './NodeBreadcrumbs';
export type { BreadcrumbItem } from './NodeBreadcrumbs';
export { PageHeader } from './PageHeader';
export { NodeContent } from './NodeContent';
export { NodeContextMenu, PageContextMenu, BlockContextMenu } from './NodeContextMenu';

// Editor components
export { BlockEditor, TASK_STATES } from './BlockEditor';
export type { TaskState } from './BlockEditor';
export { Block } from './Block';
export { BlockContentPreview } from './BlockContentPreview';
export type { BlockContentPreviewProps } from './BlockContentPreview';
export { BoxSelect } from './core/BoxSelect';
export { SuggestionPopup } from './core/SuggestionPopup';
export type { SuggestionPopupProps, SuggestionType } from './core/SuggestionPopup';
export { SlashCommandPopup } from './core/SlashCommandPopup';
export type { SlashCommandPopupProps, SlashCommand } from './core/SlashCommandPopup';

// List components
export { NodeList } from './NodeList';
export type { NodeListProps, NodeListItem, NodeListColumn, NodeListViewMode } from './NodeList';
export { TagList, TaggedNodes } from './TagList';

// Backlinks and references
export { Backlinks, LinkedReferences, References } from './Backlinks';
export { NodeViewSection } from './NodeViewSection';
export type { NodeViewSectionProps } from './NodeViewSection';
export { 
  ReferencesView, 
  LinkedReferencesList, 
  LinkedReferencesTable,
  linkedReferenceToItem,
  propertyBacklinkToPageItem,
} from '../views/ReferencesView';
export type { ReferenceItem, PageReferenceItem, ReferenceViewMode } from '../views/ReferencesView';

// Properties
export { PropertiesSection, InlineProperties } from '../views/PropertiesSection';
export { NodePicker } from './NodePicker';
export { TextPropertyBlock } from './TextPropertyBlock';
export { TypeExtendsEditor } from './TypeExtendsEditor';
export { TypePropertiesEditor } from './TypePropertiesEditor';
export { TypedNodesView } from '../views/TypedNodesView';
export { ChildPagesSection } from './ChildPagesSection';
export { PagesTree } from './PagesTree';
export type { PagesTreeProps } from './PagesTree';
export { PropertyConfigPanel } from './PropertyConfigPanel';
export { PropertyPickerModal } from './PropertyPickerModal';
export { PropertyCreateModal } from './PropertyCreateModal';
export { PropertyView } from '../views/PropertyView';

// UI components
export { Button } from './core/Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './core/Button';
export { ButtonWithPanel } from './core/ButtonWithPanel';
export type { ButtonWithPanelProps, PanelPosition, PanelAlignment } from './core/ButtonWithPanel';
export { Card, Panel } from './core/Card';
export type { CardProps, CardElevation, CardVariant, PanelProps, PanelElevation } from './core/Card';
export { SearchBox } from './core/SearchBox';
export { CalendarPopup } from './core/CalendarPopup';
export { QuickAddDialog } from './core/QuickAddDialog';
export { SidebarCard } from './SidebarCard';
export { CommandPalette } from './CommandPalette';
export type { CommandPaletteProps } from './CommandPalette';
export { Bullet } from './Bullet';
export type { BulletProps, BulletSize, BulletVariant } from './Bullet';

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
export { DraggedBlock, useDragPreview } from './core/DraggedBlock';
export type { DraggedBlockProps } from './core/DraggedBlock';
export { NodeToNodeLine, drawNodeToNodeLine } from './core/NodeToNodeLine';
export type { NodeToNodeLineProps, LineStyle, ArrowDirection } from './core/NodeToNodeLine';
export { NodeCircle, drawNodeCircle } from './core/NodeCircle';
export type { NodeCircleProps, NodeCircleState } from './core/NodeCircle';
export { PropertyList } from './core/PropertyList';
export type { PropertyListProps, PropertyEntry } from './core/PropertyList';
export { NodeListCore } from './core/NodeListCore';
export type { NodeListCoreProps, NodeListCoreItem, NodeListCoreGroup } from './core/NodeListCore';

// View components
export { GraphView } from '../views/GraphView';
export { MiniGraphView } from '../views/MiniGraphView';
export { AllPagesView } from '../views/AllPagesView';
export { JournalsView } from '../views/JournalsView';
export { SidebarNodeView } from './SidebarNodeView';
export { LocalGraphCard } from './LocalGraphCard';
export { CommentsSidebar } from './CommentsSidebar';
export { CardsView } from '../views/CardsView';
export type { CardsViewProps, CardsViewMode } from '../views/CardsView';
export { CalendarView } from '../views/CalendarView';
export type { CalendarViewProps } from '../views/CalendarView';
export { ChartView } from '../views/ChartView';
export type { ChartViewProps } from '../views/ChartView';
export { GanttView } from '../views/GanttView';
export type { GanttViewProps } from '../views/GanttView';
export { QueryView } from '../views/QueryView';
export type { QueryViewProps } from '../views/QueryView';
export { FilteredGraphView } from '../views/FilteredGraphView';
export type { FilteredGraphViewProps } from '../views/FilteredGraphView';
export { PropertyNodesView } from '../views/PropertyNodesView';
export type { PropertyNodesViewProps, PropertyViewMode } from '../views/PropertyNodesView';
export { TemplateUsedInView } from './TemplateUsedInView';

// Modal components
export { Modal } from './core/Modal';
export type { ModalProps, ModalSize } from './core/Modal';
export { SettingsModal } from './SettingsModal';
export { ConfirmationModal } from './core/ConfirmationModal';
export { DatabaseModal } from './DatabaseModal';
export { DatabaseNameModal } from './DatabaseNameModal';
export { ImportOptionsModal } from './ImportOptionsModal';
export { DatabaseSwitcher } from './DatabaseSwitcher';
export { DatabaseManagementView } from '../views/DatabaseManagementView';
export { ImageUploadModal } from './ImageUploadModal';
export { AssetUploadModal } from './AssetUploadModal';

// Image components
export { ImageBlock } from './ImageBlock';

// Asset components
export { AssetPreview } from './AssetPreview';
export { AssetBlock } from './AssetBlock';
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
export { NodePreview } from './NodePreview';

// Activity log
export { NodeActivityLog } from './NodeActivityLog';
export type { NodeActivity } from './NodeActivityLog';

// Banner and Cover images
export { BannerImage } from './BannerImage';
export { CoverImage } from './CoverImage';

// Block display (read-only with pills)
export { BlockDisplay } from './BlockDisplay';

// Link pill component
export { LinkPill } from './LinkPill';
export type { LinkType } from './LinkPill';

// Content display with pills
export { ContentWithPills } from './ContentWithPills';

// Node link components
export { NodeLink } from './NodeLink';
export type { NodeLinkProps } from './NodeLink';
export { NodeLinkSearch } from './NodeLinkSearch';
export type { NodeLinkSearchProps, LinkSearchType } from './NodeLinkSearch';

// NodeSet component
export { NodeSet, SelectionSwitch } from './NodeSet';
export type { NodeSetProps, NodeSetItem, NodeSetViewType, GroupByOption } from './NodeSet';

// Icons
export * from './icons';
