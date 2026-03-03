/**
 * NodeCollection Types
 * 
 * Type definitions for the unified NodeCollection system.
 * NodeCollection is the universal interface for displaying collections of nodes.
 */
import type { Node, Property } from './api';
import type { NodeView } from './nodeView';
import type { ReactNode } from 'react';
import type { ContextMenuItem } from '../components/core/ContextMenu';

// ==================== GroupBy Options ====================

/**
 * Available groupBy options for NodeCollection.
 * Special values: 'none' (no grouping), 'page' (group by source page).
 * Any other string is treated as a property UUID to group by.
 */
export type NodeCollectionGroupBy = string;

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
  | 'terrain'   // Terrain contour visualization
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
  
  /** Server ID of the parent page (enables real-root mode in BlockEditor) */
  pageId?: number;
  /** UUID of the parent page (enables real-root mode in BlockEditor) */
  pageUuid?: string;
  
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
  
  /** Called when a class is added to a node via @ menu (plain Enter) */
  onAddClass?: (nodeId: number, classId: number) => void;
  
  /** Called when an action-type slash command is selected (table, query, image, audio, file, comment) */
  onSlashCommand?: (commandId: string, blockServerId: number | undefined) => void;
  
  /** Called when an image is pasted into a block */
  onPasteImage?: (blockServerId: number, file: File, hasContent: boolean) => void;
  
  /** Called when Enter is pressed on the root block (instead of creating a child) */
  onEnterAtRoot?: () => void;
  
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
  
  /** Whether to show classes for each node in list view (default: false) */
  showClasses?: boolean;
  
  /** Page map for resolving page nodes by ID (needed for groupBy='page') */
  pageMap?: Map<number, Node>;
  
  /** Columns for table view (optional, uses defaults if not provided) */
  tableColumns?: {
    key: string;
    label: string;
    width?: string;
    render?: (node: Node) => ReactNode;
  }[];

  /** Start date property for gantt view */
  ganttStartDateProperty?: Property;

  /** End date property for gantt view */
  ganttEndDateProperty?: Property;

  /** Called when gantt start date property changes */
  onGanttStartDatePropertyChange?: (property: Property | undefined) => void;

  /** Called when gantt end date property changes */
  onGanttEndDatePropertyChange?: (property: Property | undefined) => void;
  
  /** Whether to auto-collapse nodes at configured depth (default: false, enabled for linked refs and queries) */
  autoCollapse?: boolean;
  
  /** Whether to wrap spatial views (graph, terrain) in a Card container (default: false) */
  containerCard?: boolean;

  /** Active/current node to include in graph/terrain views (e.g., the page being viewed) */
  activeNode?: { id: number; uuid: string; name: string };
  
  /** Element to render between the header and content (e.g., property references section) */
  beforeContent?: ReactNode;
  
  /** Controlled property UUIDs to show as table columns */
  selectedPropertyUuids?: string[];
  
  /** Called when property column selection changes */
  onPropertyColumnsChange?: (uuids: string[]) => void;
  
  /** Whether to hide the built-in toolbar (use when rendering toolbar externally) */
  hideToolbar?: boolean;
  
  /** Element(s) to render before the default toolbar controls */
  toolbarPrefix?: ReactNode;
  
  /** Element to render at left side of toolbar */
  leftElement?: ReactNode;
  
  /** Hide toolbar controls while keeping leftElement visible */
  hideToolbarControls?: boolean;
  
  /** Hide the content area while keeping toolbar visible */
  hideContent?: boolean;
  
  /** Show the add button in toolbar */
  showAddButton?: boolean;
  
  /** Callback when add button is clicked */
  onAdd?: () => void;
  
  /** Whether new items can be created (default: true) */
  can_create?: boolean;
  
  /** Whether items can be edited (default: true) */
  can_edit?: boolean;
  
  /** Whether items can be deleted (default: true) */
  can_delete?: boolean;
  
  /** Whether to show empty state message (default: true) */
  showEmpty?: boolean;
  
  /** Custom empty state message */
  emptyMessage?: string;
  
  /** Maximum recursion depth for nested views */
  maxDepth?: number;
  
  /** Use isolated block state (for blocks in multiple places like linked refs) */
  isolatedBlockState?: boolean;
  
  /** Suppress color styling on root-level nodes */
  suppressRootColor?: boolean;
  
  /** Card layout style */
  cardLayout?: 'no-cover' | 'cover-top' | 'cover-left' | 'cover-right';
  
  /** Called when card layout changes */
  onCardLayoutChange?: (layout: 'no-cover' | 'cover-top' | 'cover-left' | 'cover-right') => void;
  
  /** Custom context menu component */
  customContextMenu?: React.ComponentType<{
    node: Node;
    position: { x: number; y: number };
    onClose: () => void;
  }>;
  
  /** Custom context menu items generator */
  customContextMenuItems?: (node: Node, closeMenu: () => void) => ContextMenuItem[];
}

// ==================== View-Specific Props ====================

/**
 * Base props shared by all view mode components
 */
export interface NodeCollectionViewBaseProps {
  /** Nodes to display */
  nodes: Node[];
  
  /** Server ID of the parent page */
  pageId?: number;
  /** UUID of the parent page */
  pageUuid?: string;
  
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
  
  /** Add class handler (called when @ menu adds class via plain Enter) */
  onAddClass?: (nodeId: number, classId: number) => void;
  
  /** Called when an action-type slash command is selected (table, query, image, audio, file, comment, property, url) */
  onSlashCommand?: (commandId: string, blockServerId: number | undefined) => void;
  
  /** Called when an image is pasted into a block */
  onPasteImage?: (blockServerId: number, file: File, hasContent: boolean) => void;
  
  /** Called when Enter is pressed on the root block (instead of creating a child) */
  onEnterAtRoot?: () => void;
  
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
  
  /** Whether to auto-collapse nodes at configured depth (default: false) */
  autoCollapse?: boolean;
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
  
  /** Whether to show classes for each node (default: false) */
  showClasses?: boolean;
  
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

  /** Property object when groupBy is a property UUID */
  groupByProperty?: Property;
  
  /** Whether grouping is enabled (default: false) */
  enableGrouping?: boolean;
}

/**
 * Props for NodeDocumentView (document mode)
 * Document mode has no extra props - just flat recursive display
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface NodeDocumentViewProps extends NodeCollectionViewBaseProps {
  // Intentionally empty - inherits all props from base
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
  
  /** Group by option - when 'page', displays as kanban columns; property UUID for property-based kanban */
  groupBy?: NodeCollectionGroupBy;

  /** Property object when groupBy is a property UUID */
  groupByProperty?: Property;
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
  /** Property to use for the start date of each bar */
  startDateProperty?: Property;

  /** Property to use for the end date of each bar */
  endDateProperty?: Property;

  /** Time scale (day, week, month) */
  timeScale?: 'day' | 'week' | 'month';

  /** Group by option (same as NodeCollectionGroupBy) */
  groupBy?: string;

  /** Property to group by when groupBy is a property UUID */
  groupByProperty?: Property;
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
