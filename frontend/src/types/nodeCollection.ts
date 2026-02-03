/**
 * NodeCollection Types
 * 
 * Type definitions for the unified NodeCollection system.
 * NodeCollection is the universal interface for displaying collections of nodes.
 */
import type { Node } from './api';
import type { NodeView } from './query';
import type { ReactNode } from 'react';
import type { ContextMenuItem } from '../components/core/ContextMenu';

// ==================== GroupBy Options ====================

/**
 * Available groupBy options for NodeCollection
 */
export type NodeCollectionGroupBy = 'none' | 'page';

/**
 * GroupBy option with label for UI display
 */
export interface GroupByOption {
  value: NodeCollectionGroupBy;
  label: string;
}

/**
 * Default groupBy options
 */
export const GROUP_BY_OPTIONS: GroupByOption[] = [
  { value: 'none', label: 'None' },
  { value: 'page', label: 'Page' },
];

// ==================== View Modes ====================

/**
 * Available view modes for NodeCollection
 */
export type NodeCollectionViewMode = 
  | 'list'      // Bullet list with indentation (outline)
  | 'document'  // Flat list without bullets (document style)
  | 'card'      // Card grid layout
  | 'table'     // Table with rows
  | 'gantt'     // Timeline/Gantt view
  | 'graph'     // Graph visualization
  | 'timeline'; // Timeline with date-based circular nodes

/**
 * View mode icon and label for UI display
 */
export interface ViewModeOption {
  mode: NodeCollectionViewMode;
  icon: string;
  label: string;
}

// ==================== NodeCollection Props ====================

/**
 * Props for the NodeCollection component
 */
export interface NodeCollectionProps {
  /** Main nodes to display */
  nodes: Node[];
  
  /** Optional view ID for persisting configuration (property columns, etc.) */
  viewId?: number;
  
  /** Optional view object for loading persisted configuration */
  view?: NodeView;
  
  /** Current view mode */
  viewMode: NodeCollectionViewMode;
  
  /** Available view modes (if only one, hides the view switcher) */
  availableViewModes?: NodeCollectionViewMode[];
  
  /** Called when view mode changes */
  onViewModeChange?: (mode: NodeCollectionViewMode) => void;
  
  /** Whether nodes are editable (default: true) */
  editable?: boolean;
  
  /** Whether list is sortable (enables drag-and-drop reordering) */
  sortable?: boolean;
  
  /** Called when nodes are reordered (only when sortable=true) */
  onReorder?: (fromIndex: number, toIndex: number) => void;
  
  /** Action to render on each item (for remove buttons, etc.) */
  renderItemAction?: (node: Node, index: number) => ReactNode;
  
  /** Optional custom node renderer */
  renderNode?: (node: Node, editable: boolean) => ReactNode;
  
  /** Called when a node is clicked */
  onNodeClick?: (node: Node) => void;
  
  /** Called when a node is shift-clicked (open in sidebar) */
  onNodeShiftClick?: (node: Node) => void;
  
  /** Called when node content changes (only in edit mode) */
  onContentChange?: (nodeId: number, content: string) => void;
  
  /** Additional CSS class */
  className?: string;
  
  /** Group by option (default: 'page' for list view) */
  groupBy?: NodeCollectionGroupBy;
  
  /** Called when groupBy changes */
  onGroupByChange?: (groupBy: NodeCollectionGroupBy) => void;
  
  /** Whether to show the groupBy selector (default: false) */
  showGroupBy?: boolean;
  
  /** Only show nodes with is_page=true in list view (filters both top-level and children) */
  pagesOnly?: boolean;
  
  /** Whether to show types/classes for each node in list view (default: false) */
  showTypes?: boolean;
  
  /** Page map for resolving page nodes by ID (needed for groupBy='page') */
  pageMap?: Map<number, Node>;
  
  /** Columns for table view (optional, uses defaults if not provided) */
  tableColumns?: {
    key: string;
    label: string;
    width?: string;
    render?: (node: Node) => ReactNode;
  }[];
  
  /** 
   * Whether to provide block callbacks via context.
   * When true with blockCallbacks provided, wraps content in BlockCallbacksProvider.
   * When true without blockCallbacks, uses default callbacks from hooks.
   * When false/undefined, no provider is used (Block becomes effectively read-only).
   */
  provideBlockCallbacks?: boolean;
  
  /** 
   * Custom block callbacks to provide via context.
   * Only used when provideBlockCallbacks is true.
   */
  blockCallbacks?: {
    onAddClass?: (blockId: number, classNodeId: number, keepInline: boolean, className: string) => void;
    onAddTag?: (blockId: number, tagNodeId: number, keepInline: boolean, tagName: string) => void;
    onCreateClass?: (blockId: number, name: string, keepInline: boolean) => void;
    onCreateTag?: (blockId: number, name: string, keepInline: boolean) => void;
    onCreatePageLink?: (name: string) => Promise<string | undefined>;
    onOpenComments?: (blockId: number) => void;
    onAssetUpload?: (blockId: number, assetTypesOrFile?: ('image' | 'audio' | 'file')[] | File) => void;
    onOpenBacklinks?: (blockId: number) => void;
    getCommentCount?: (block: Node) => number;
    getBacklinkCount?: (block: Node) => number;
  };
  
  /** Whether to show empty state */
  showEmpty?: boolean;
  
  /** Empty state message */
  emptyMessage?: string;
  
  /** Maximum depth for recursive rendering (default: unlimited) */
  maxDepth?: number;
  
  /** Use isolated block state (for blocks that appear in multiple places like linked references) */
  isolatedBlockState?: boolean;
  
  /** Suppress color styling on root-level nodes (used when color is applied at container level) */
  suppressRootColor?: boolean;
  
  /** Hide the internal toolbar (use when rendering toolbar externally via NodeCollectionToolbar) */
  hideToolbar?: boolean;
  
  /** Custom content to render at the start of the toolbar */
  toolbarPrefix?: React.ReactNode;
  
  /** Element to render at the left side of the toolbar (e.g., block element, collapsible header).
   * Can be a ReactNode or a function that receives the result count for dynamic rendering. */
  leftElement?: React.ReactNode | ((count: number) => React.ReactNode);
  
  /** Hide toolbar controls while keeping leftElement visible (for collapsed sections) */
  hideToolbarControls?: boolean;
  
  /** Hide the content area while keeping toolbar visible (for collapsed sections) */
  hideContent?: boolean;
  
  /** Show "Add" button in the toolbar (default: false) */
  showAddButton?: boolean;
  
  /** Callback when Add button is clicked */
  onAdd?: () => void;
  
  /** Card layout mode for card view */
  cardLayout?: 'no-cover' | 'cover-top' | 'cover-bottom' | 'cover-left' | 'cover-right';
  
  /** Called when card layout changes */
  onCardLayoutChange?: (layout: string) => void;
  
  /** Selected property UUIDs for table view columns (controlled) */
  selectedPropertyUuids?: string[];
  
  /** Called when property column selection changes */
  onPropertyColumnsChange?: (propertyUuids: string[]) => void;
  
  /** Custom context menu component to use instead of default PageContextMenu/BlockContextMenu */
  customContextMenu?: React.ComponentType<{
    node: Node;
    position: { x: number; y: number };
    onClose: () => void;
  }>;
  
  /** Custom context menu items generator (for list view with Block component) */
  customContextMenuItems?: (node: Node, closeMenu: () => void) => ContextMenuItem[];
}

// ==================== View-Specific Props ====================

/**
 * Base props shared by all view mode components
 */
export interface NodeCollectionViewBaseProps {
  /** Nodes to display */
  nodes: Node[];
  
  /** Whether nodes are editable */
  editable: boolean;
  
  /** Current depth level (for recursive views) */
  depth?: number;
  
  /** Maximum depth for recursion */
  maxDepth?: number;
  
  /** Node click handler */
  onNodeClick?: (node: Node) => void;
  
  /** Node shift-click handler */
  onNodeShiftClick?: (node: Node) => void;
  
  /** Content change handler */
  onContentChange?: (nodeId: number, content: string) => void;
  
  /** Custom node renderer */
  renderNode?: (node: Node, editable: boolean) => ReactNode;
  
  /** Additional CSS class */
  className?: string;
  
  /** Use isolated block state (for blocks that appear in multiple places like linked references) */
  isolatedBlockState?: boolean;
  
  /** Suppress color styling on root-level nodes (used when color is applied at container level) */
  suppressRootColor?: boolean;
  
  /** Custom context menu component to use instead of default PageContextMenu/BlockContextMenu */
  customContextMenu?: React.ComponentType<{
    node: Node;
    position: { x: number; y: number };
    onClose: () => void;
  }>;
  
  /** Custom context menu items generator (for list view with Block component) */
  customContextMenuItems?: (node: Node, closeMenu: () => void) => ContextMenuItem[];
}

/**
 * Props for NodeListView (outline mode)
 */
export interface NodeListViewProps extends NodeCollectionViewBaseProps {
  /** Whether to show bullets (default: true) */
  showBullets?: boolean;
  
  /** Whether to show indentation (default: true) */
  showIndentation?: boolean;
  
  /** Whether to show breadcrumbs for top-level nodes (default: true) */
  showBreadcrumbs?: boolean;
  
  /** Whether to show types/classes for each node (default: false) */
  showTypes?: boolean;
  
  /** Only show nodes with is_page=true (filters both top-level and children) */
  pagesOnly?: boolean;
  
  /** Whether list is sortable (enables drag-and-drop reordering) */
  sortable?: boolean;
  
  /** Called when nodes are reordered (only when sortable=true) */
  onReorder?: (fromIndex: number, toIndex: number) => void;
  
  /** Action to render on each item (for remove buttons, etc.) */
  renderItemAction?: (node: Node, index: number) => ReactNode;
  
  /** Page map for breadcrumb resolution */
  pageMap?: Map<number, Node>;
  
  /** Group by option (default: 'none' when showGroupBy is false) */
  groupBy?: NodeCollectionGroupBy;
  
  /** Whether grouping is enabled (default: false) */
  enableGrouping?: boolean;
}

/**
 * Props for NodeDocumentView (document mode)
 */
export interface NodeDocumentViewProps extends NodeCollectionViewBaseProps {
  // Document mode has no extra props - just flat recursive display
}

/**
 * Props for NodeCardView (card mode)
 */
export interface NodeCardViewProps extends NodeCollectionViewBaseProps {
  /** Card layout style */
  layout?: 'no-cover' | 'cover-top' | 'cover-left' | 'cover-right';
  
  /** Number of columns (default: auto) */
  columns?: number;
  
  /** Whether cards are sortable (enables drag-and-drop reordering) */
  sortable?: boolean;
  
  /** Called when nodes are reordered (only when sortable=true) */
  onReorder?: (fromIndex: number, toIndex: number) => void;
  
  /** Whether cards are selectable (shows checkbox on hover) */
  selectable?: boolean;
  
  /** Callback when Add button is clicked */
  onAdd?: () => void;
  
  /** Controlled selected node IDs */
  selectedIds?: Set<number>;
  
  /** Called when selection changes */
  onSelectionChange?: (selectedIds: Set<number>) => void;
}

/**
 * Props for NodeTableView (table mode)
 */
export interface NodeTableViewProps extends NodeCollectionViewBaseProps {
  /** Columns to display */
  columns?: {
    key: string;
    label: string;
    width?: string;
    render?: (node: Node) => ReactNode;
  }[];
  
  /** Whether to show expandable rows for children */
  expandable?: boolean;
  
  /** Whether rows are sortable (enables drag-and-drop reordering) */
  sortable?: boolean;
  
  /** Called when nodes are reordered (only when sortable=true) */
  onReorder?: (fromIndex: number, toIndex: number) => void;
  
  /** Whether rows are selectable (shows checkbox column) */
  selectable?: boolean;
  
  /** Controlled selected node IDs */
  selectedIds?: Set<number>;
  
  /** Property UUIDs to show as columns */
  propertyUuids?: string[];
  
  /** Called when selection changes */
  onSelectionChange?: (selectedIds: Set<number>) => void;
}

/**
 * Props for NodeGanttView (gantt mode)
 */
export interface NodeGanttViewProps extends NodeCollectionViewBaseProps {
  /** Date property to use for positioning */
  dateProperty?: string;
  
  /** Time scale (day, week, month) */
  timeScale?: 'day' | 'week' | 'month';
}

// ==================== Context ====================

/**
 * Context value for NodeCollection - passed down to all children
 */
export interface NodeCollectionContextValue {
  /** Whether content is editable */
  editable: boolean;
  
  /** Node click handler */
  onNodeClick?: (node: Node) => void;
  
  /** Node shift-click handler */
  onNodeShiftClick?: (node: Node) => void;
  
  /** Content change handler */
  onContentChange?: (nodeId: number, content: string) => void;
  
  /** Current depth */
  depth: number;
  
  /** Maximum depth */
  maxDepth: number;
}
