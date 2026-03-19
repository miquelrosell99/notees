/**
 * Drag and Drop Types
 * 
 * Shared types for @dnd-kit-based drag-and-drop across the application.
 */

// ==================== Drag Item Types ====================

/**
 * Type discriminator for different draggable items in the app
 */
export type DragItemType = 
  | 'block'            // Document blocks (hierarchical tree)
  | 'card'             // Node cards in card view
  | 'list-item'        // Node list items
  | 'sidebar-item'     // Sidebar favorites/recent
  | 'property-column'  // Table column reordering
  | 'graph-node'       // Graph view nodes (may not use @dnd-kit)
  | 'file';            // External file drops

// ==================== Drag Data ====================

/**
 * Data attached to a draggable item
 */
export interface DragData {
  /** Type of item being dragged */
  type: DragItemType;
  /** Unique identifier for the item */
  id: string | number;
  /** Additional payload specific to the drag type */
  payload?: unknown;
}

/**
 * Data for dragging blocks (supports multi-select)
 */
export interface BlockDragData extends DragData {
  type: 'block';
  id: number;
  payload: {
    /** The primary block being dragged */
    blockId: number;
    /** Additional selected blocks being dragged together */
    selectedBlockIds?: number[];
    /** Parent ID for context */
    parentId: number | null;
    /** Whether this is a page block */
    isPage: boolean;
  };
}

/**
 * Data for dragging node cards/list items
 */
export interface NodeDragData extends DragData {
  type: 'card' | 'list-item';
  id: number;
  payload: {
    nodeId: number;
    nodeName: string;
    isPage: boolean;
  };
}

// ==================== Drop Position ====================

/**
 * Where an item is being dropped relative to another
 */
export type DropPosition = 'before' | 'after' | 'inside';

/**
 * Drop target information
 */
export interface DropTarget {
  /** ID of the target item */
  id: string | number;
  /** Position relative to target */
  position: DropPosition;
  /** Type of the target */
  type: DragItemType;
}

// ==================== Drop Result ====================

/**
 * Result of a drag-and-drop operation
 */
export interface DropResult {
  /** The dragged item data */
  drag: DragData;
  /** The drop target */
  drop: DropTarget;
  /** Whether this was a move (vs copy) */
  isMove: boolean;
}

// ==================== Sensor Configuration ====================

/**
 * Activation constraints for drag sensors.
 * Matches @dnd-kit/core PointerActivationConstraint / DelayConstraint union.
 */
export type DragActivationConstraint =
  | { distance: number }
  | { delay: number; tolerance: number }
  | { distance: number; delay: number; tolerance: number };

/**
 * Configuration for drag sensors
 */
export interface DragSensorConfig {
  pointer?: DragActivationConstraint;
  keyboard?: boolean;
  touch?: DragActivationConstraint;
}

// ==================== Accessibility ====================

/**
 * Accessibility announcements for screen readers
 */
export interface DragAnnouncements {
  onDragStart?: (itemName: string) => string;
  onDragOver?: (itemName: string, targetName: string) => string;
  onDragEnd?: (itemName: string, result: 'dropped' | 'cancelled') => string;
}

// ==================== Tree/Nesting ====================

/**
 * For hierarchical drag-and-drop (blocks, query builder)
 */
export interface TreeDragData {
  /** Current depth in tree */
  depth: number;
  /** Whether item can accept children */
  canHaveChildren: boolean;
  /** Whether item is expanded */
  isExpanded?: boolean;
  /** Parent chain for detecting invalid drops (prevent drop into own children) */
  ancestorIds: Array<string | number>;
}

/**
 * Extended drag data for tree structures
 */
export interface TreeItemDragData extends DragData {
  tree: TreeDragData;
}
