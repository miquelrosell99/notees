/**
 * Components module - exports all components
 */

// Layout components
export { Layout } from './layout/Layout';
export { TopBar } from './layout/TopBar';
export { Sidebar } from './layout/NavigationSidebar';
export { MainContent } from './layout/MainContent';
export { CommandPalette } from './layout/CommandPalette';
export type { CommandPaletteProps } from './layout/CommandPalette';
export { SettingsModal } from './layout/SettingsModal';
export { Scratchpad } from './layout/Scratchpad';

// Auth components
export { LoginPage } from '../views/LoginPage';

// Page components
export { NodeView } from '../views/NodeView';

// Node components (from nodes/ folder)
export { NodeBreadcrumbs } from './nodes/NodeBreadcrumbs';
export type { BreadcrumbItem } from './nodes/NodeBreadcrumbs';
export { PageHeader } from './nodes/PageHeader';
export { NodeContent } from './nodes/NodeContent';
export { NodeContextMenu, PageContextMenu, BlockContextMenu } from './nodes/NodeContextMenu';
export { SuggestionPopup } from './nodes/SuggestionPopup';
export type { SuggestionPopupProps, SuggestionType } from './nodes/SuggestionPopup';
export { NodeViewSection } from './nodes/NodeViewSection';
export type { NodeViewSectionProps } from './nodes/NodeViewSection';

// Block components
export { NodeInline } from './blocks/NodeInline';
export type { NodeInlineProps } from './blocks/NodeInline';
export { Bullet } from './blocks/Bullet';
export type { BulletProps, BulletSize, BulletVariant } from './blocks/Bullet';
export { TextPropertyBlock } from './blocks/TextPropertyBlock';

// NoteesEditor (Lexical-based editor)
export { NoteesEditor } from '../editor/NoteesEditor';
export type { NoteesEditorProps } from '../editor/NoteesEditor';

// NodeGraphRuntime
export { getNodeGraphRuntime, resetNodeGraphRuntime } from '../runtime/NodeGraphRuntime';

// Properties (from properties/ folder)
export { PropertiesSection, InlineProperties } from './properties/PropertiesSection';
export { ClassPropertiesEditor } from './properties/ClassPropertiesEditor';
export { PropertyList } from './properties/PropertyList';
export type { PropertyListProps, PropertyEntry } from './properties/PropertyList';
export { PropertyView } from '../views/PropertyView';

// Core UI components
export { Button } from './core/Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './core/Button';
export { ButtonWithPanel } from './core/ButtonWithPanel';
export type { ButtonWithPanelProps, PanelPosition, PanelAlignment } from './core/ButtonWithPanel';
export { Card } from './core/Card';
export type { CardProps, CardElevation, CardVariant } from './core/Card';
export { SearchBox } from './core/SearchBox';
export { CalendarPopup } from './core/CalendarPopup';
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

export { QuickAddPanel } from './quickadd/QuickAddPanel';
export { SidebarCard } from './sidebar/SidebarCard';

// Node graph visualization components (force-directed graph)
export { 
  NodeGraphRenderer,
  NodeGraphView,
  GraphViewAllCard,
  GraphViewLocal,
} from './nodeGraph';
export type { 
  NodeGraphRendererRef,
  GraphNode,
  GraphLink,
  NodeGraphViewProps,
  GraphViewAllCardProps,
  GraphViewLocalProps,
} from './nodeGraph';

// View components
export { AllPagesView } from '../views/AllPagesView';
export { JournalsView } from '../views/JournalsView';
export { SidebarNodeView } from './sidebar/SidebarNodeView';
export { CommentsSidebar } from './sidebar/CommentsSidebar';

// Modal components
export { Modal } from './core/Modal';
export type { ModalProps, ModalSize } from './core/Modal';
export { ConfirmationModal } from './core/ConfirmationModal';
export { WorkspaceModal } from './workspace/WorkspaceModal';
export { WorkspaceNameModal } from './workspace/WorkspaceNameModal';
export { ImportOptionsModal } from './workspace/ImportOptionsModal';
export { ImportDataModal } from './workspace/ImportDataModal';
export { WorkspaceSwitcher } from './workspace/WorkspaceSwitcher';
export { WorkspaceManagementView } from '../views/WorkspaceManagementView';
export { AssetUploadModal } from './assets/AssetUploadModal';

// Emoji/Icon picker
export { EmojiPicker, EmojiPickerTrigger } from './core/EmojiPicker';

// Color button
export { ColorButton } from './core/ColorButton';

// Context menu
export { ContextMenu } from './core/ContextMenu';
export type { ContextMenuItem } from './core/ContextMenu';

// Activity log
export { NodeActivityLogSection } from './nodes/NodeActivityLogSection';
export type { NodeActivity } from './nodes/NodeActivityLogSection';

// NodeCollection - Universal node collection system
export { NodeCollection, useNodeCollectionContext, getViewModeOptions } from './nodes/NodeCollection';
export type { NodeCollectionProps, NodeCollectionViewMode } from './nodes/NodeCollection';

// NodeCollection view mode components
export { ListView } from './nodes/views/ListView';
export { DocumentView } from './nodes/views/DocumentView';
export { CardView } from './nodes/views/CardView';
export { TableView } from './nodes/views/TableView';
export { GanttView } from './nodes/views/GanttView';

// Query builder components
export { ViewBuilder } from './queries';

// Icons
export * from './core/icons';
