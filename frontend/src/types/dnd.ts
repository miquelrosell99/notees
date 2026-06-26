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
  nodeUuid: string;
  /** Additional payload specific to the drag type */
  payload?: unknown;
}

/**
 * Data for dragging blocks (supports multi-select)
 */
export interface BlockDragData extends DragData {
  type: 'block';
  nodeUuid: string;
  payload: {
    /** The primary block being dragged */
    blockUuid: string;
    /** Additional selected blocks being dragged together */
    selectedBlockUuids?: string[];
    /** Parent UUID for context */
    parentUuid: string | null;
    /** Whether this is a page block */
    isPage: boolean;
  };
}

/**
 * Data for dragging node cards/list items
 */
export interface NodeDragData extends DragData {
  type: 'card' | 'list-item';
  nodeUuid: string;
  payload: {
    nodeUuid: string;
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
  /** UUID of the target item */
  uuid: string;
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
  ancestorUuids: string[];
}

/**
 * Extended drag data for tree structures
 */
export interface TreeItemDragData extends DragData {
  tree: TreeDragData;
}
