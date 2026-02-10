/**
 * Block Selection Store
 * 
 * Manages state for:
 * - Block states: display, edit, selected (mutually exclusive)
 * - Selection mode
 * - Drag and drop state
 * - Box selection
 * - Editor selection (caret position) - MODEL-FIRST approach
 * 
 * Block State Model:
 * - display: Default state, block shows content as read-only
 * - edit: User is editing the block content
 * - selected: Block is selected (for multi-select, drag, etc.)
 * 
 * State Transitions:
 * - display -> edit: Click on block content
 * - edit -> selected: Press Escape
 * - edit -> display: Click outside block content
 * - selected -> edit: Press Enter or click on content
 * - selected -> display: Press Escape or click elsewhere
 * 
 * Editor Selection Model:
 * - Selection is stored centrally as the source of truth (not DOM)
 * - DOM selection is a PROJECTION of the model selection
 * - Before mutations: capture selection to pendingSelection
 * - After re-render: restore selection from pendingSelection
 */
import { create } from 'zustand';

export type BlockState = 'display' | 'edit' | 'selected';
export type SelectionMode = 'editing' | 'selected' | 'none';

/** Direction of selection expansion for keyboard navigation */
export type SelectionDirection = 'up' | 'down' | null;

/**
 * Editor Selection - Model-first caret/selection representation
 * 
 * Uses character offsets (not DOM offsets) for stable positioning.
 * Character offset counts text characters, treating atomic inline links as their raw content length.
 */
export interface EditorSelection {
  /** The block containing the anchor point */
  anchorBlockId: number;
  /** Character offset in the anchor block */
  anchorOffset: number;
  /** The block containing the focus point (same as anchor for collapsed selection) */
  focusBlockId: number;
  /** Character offset in the focus block */
  focusOffset: number;
  /** Horizontal X position for preserving caret position during vertical navigation */
  caretX?: number;
  /** Click coordinates for projection-based cursor placement */
  clickX?: number;
  clickY?: number;
}

export interface DragState {
  isDragging: boolean;
  draggedBlockId: number | null;
  draggedBlockIds: number[];  // For multi-select drag
  dropTargetId: number | null;
  dropPosition: 'before' | 'after' | 'inside' | null;
}

export interface BoxSelectState {
  isBoxSelecting: boolean;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

/** 
 * Drag Selection State
 * Tracks when user drags over blocks to select them
 */
export interface DragSelectState {
  isDragSelecting: boolean;
  startBlockId: number | null;
}

/** Anchor block for keyboard range selection */
export interface SelectionAnchor {
  blockId: number;
  direction: SelectionDirection;
}

/**
 * Operation Queue Entry
 * 
 * Tracks in-flight structural operations to prevent race conditions.
 * Operations like split, merge, indent, outdent should wait for pending
 * operations to complete before executing.
 */
export interface OperationQueueEntry {
  /** Unique ID for this operation */
  id: string;
  /** Type of operation for debugging */
  type: 'split' | 'merge' | 'indent' | 'outdent' | 'move' | 'delete' | 'create';
  /** Block IDs affected by this operation */
  blockIds: number[];
  /** Promise that resolves when operation completes */
  promise: Promise<void>;
  /** Timestamp for tracking operation duration */
  startTime: number;
}

interface BlockSelectionState {
  // Individual block states (for all blocks in view)
  blockStates: Map<number, BlockState>;
  
  // Selected block IDs (including children when parent is selected)
  selectedBlockIds: Set<number>;
  
  // The primary selected block (for single selection operations)
  primarySelectedBlockId: number | null;
  
  // Current mode
  selectionMode: SelectionMode;
  
  // Currently editing block ID
  editingBlockId: number | null;
  
  // === Editor Selection (Model-First) ===
  // Current editor selection (caret position in the editing block)
  editorSelection: EditorSelection | null;
  
  // Pending selection to restore after mutations/re-renders
  pendingSelection: EditorSelection | null;
  
  // === Operation Queue ===
  // In-flight operations to prevent race conditions
  operationQueue: Map<string, OperationQueueEntry>;
  
  // Drag state
  dragState: DragState;
  
  // Box selection state
  boxSelectState: BoxSelectState;
  
  // Drag selection state (for dragging over blocks)
  dragSelectState: DragSelectState;
  
  // Block registry for position lookups (updated by components)
  blockElements: Map<number, HTMLElement>;
  
  // Ordered list of visible block IDs (for navigation)
  visibleBlockIds: number[];
  
  // Block parent mapping for hierarchy
  blockParentMap: Map<number, number | null>;
  
  // Block children mapping
  blockChildrenMap: Map<number, number[]>;
  
  // Selection anchor for keyboard range selection
  selectionAnchor: SelectionAnchor | null;
  
  // Actions
  // Block state management
  getBlockState: (blockId: number) => BlockState;
  setBlockState: (blockId: number, state: BlockState) => void;
  setAllBlocksToDisplay: () => void;
  
  selectBlock: (blockId: number, includeChildren?: boolean) => void;
  selectBlocks: (blockIds: number[]) => void;
  selectBlocksInRange: (startId: number, endId: number) => void;
  addToSelection: (blockId: number, includeChildren?: boolean) => void;
  removeFromSelection: (blockId: number) => void;
  clearSelection: () => void;
  toggleBlockSelection: (blockId: number) => void;
  
  // Selection mode
  enterEditMode: (blockId: number) => void;
  exitEditMode: () => void;
  setSelectionMode: (mode: SelectionMode) => void;
  
  // === Editor Selection Actions ===
  // Set the current editor selection (e.g., when caret moves)
  setEditorSelection: (selection: EditorSelection | null) => void;
  
  // Set pending selection to restore after mutations
  setPendingSelection: (selection: EditorSelection | null) => void;
  
  // Clear pending selection after it has been restored
  clearPendingSelection: () => void;
  
  // Convenience: set pending selection for a specific block and offset
  setPendingCaret: (blockId: number, offset: number, caretX?: number, clickCoords?: { x: number; y: number }) => void;
  
  // Drag and drop
  startDrag: (blockId: number) => void;
  updateDragTarget: (targetId: number | null, position: 'before' | 'after' | 'inside' | null) => void;
  endDrag: () => void;
  
  // Box selection
  startBoxSelect: (x: number, y: number) => void;
  updateBoxSelect: (x: number, y: number) => void;
  endBoxSelect: () => void;
  
  // Drag selection (for dragging over blocks to select them)
  startDragSelect: (blockId: number) => void;
  updateDragSelect: (blockId: number) => void;
  endDragSelect: () => void;
  
  // Block registry
  registerBlock: (blockId: number, element: HTMLElement) => void;
  unregisterBlock: (blockId: number) => void;
  
  // Block hierarchy
  setVisibleBlocks: (blockIds: number[]) => void;
  setBlockHierarchy: (parentMap: Map<number, number | null>, childrenMap: Map<number, number[]>) => void;
  
  // Navigation
  getNextBlockId: (currentId: number, direction: 'up' | 'down') => number | null;
  getNextSiblingId: (currentId: number, direction: 'up' | 'down') => number | null;
  
  // Get all children recursively
  getAllChildrenIds: (blockId: number) => number[];
  
  // Keyboard selection extension (Shift+Up/Down)
  extendSelectionKeyboard: (direction: 'up' | 'down') => void;
  
  // === Operation Queue Actions ===
  // Start tracking an operation (returns operation ID)
  startOperation: (
    type: OperationQueueEntry['type'],
    blockIds: number[],
    promise: Promise<void>
  ) => string;
  
  // End/complete an operation
  endOperation: (operationId: string) => void;
  
  // Check if any operation is pending for given block(s)
  hasBlockingOperation: (blockIds: number[]) => boolean;
  
  // Wait for all operations affecting given blocks to complete
  waitForOperations: (blockIds: number[]) => Promise<void>;
  
  // Get all pending operations (for debugging)
  getPendingOperations: () => OperationQueueEntry[];
}

export const useBlockSelectionStore = create<BlockSelectionState>()((set, get) => ({
  blockStates: new Map(),
  selectedBlockIds: new Set(),
  primarySelectedBlockId: null,
  selectionMode: 'none',
  editingBlockId: null,
  
  // Editor selection state
  editorSelection: null,
  pendingSelection: null,
  
  // Operation queue for race condition protection
  operationQueue: new Map(),
  
  dragState: {
    isDragging: false,
    draggedBlockId: null,
    draggedBlockIds: [],
    dropTargetId: null,
    dropPosition: null,
  },
  boxSelectState: {
    isBoxSelecting: false,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
  },
  dragSelectState: {
    isDragSelecting: false,
    startBlockId: null,
  },
  blockElements: new Map(),
  visibleBlockIds: [],
  blockParentMap: new Map(),
  blockChildrenMap: new Map(),
  selectionAnchor: null,
  
  // Get a block's current state (defaults to 'display')
  getBlockState: (blockId) => {
    const state = get();
    return state.blockStates.get(blockId) || 'display';
  },
  
  // Set a single block's state
  setBlockState: (blockId, blockState) => {
    const state = get();
    const newBlockStates = new Map(state.blockStates);
    
    // If setting to 'edit', clear all other edit states first
    if (blockState === 'edit') {
      newBlockStates.forEach((_, key) => {
        if (newBlockStates.get(key) === 'edit') {
          newBlockStates.set(key, 'display');
        }
      });
    }
    
    // If setting to 'selected', clear edit state
    if (blockState === 'selected') {
      newBlockStates.forEach((_, key) => {
        if (newBlockStates.get(key) === 'edit') {
          newBlockStates.set(key, 'display');
        }
      });
    }
    
    newBlockStates.set(blockId, blockState);
    
    // Update related state
    if (blockState === 'edit') {
      set({
        blockStates: newBlockStates,
        editingBlockId: blockId,
        selectionMode: 'editing',
        selectedBlockIds: new Set(),
        primarySelectedBlockId: null,
        selectionAnchor: null,
      });
    } else if (blockState === 'selected') {
      const selectedIds = new Set([blockId]);
      const childIds = state.getAllChildrenIds(blockId);
      childIds.forEach(id => selectedIds.add(id));
      
      set({
        blockStates: newBlockStates,
        selectedBlockIds: selectedIds,
        primarySelectedBlockId: blockId,
        selectionMode: 'selected',
        editingBlockId: null,
        selectionAnchor: { blockId, direction: null },
      });
    } else {
      set({
        blockStates: newBlockStates,
        editingBlockId: state.editingBlockId === blockId ? null : state.editingBlockId,
      });
    }
  },
  
  // Set all blocks to display state (used on node load)
  setAllBlocksToDisplay: () => {
    set({
      blockStates: new Map(),
      selectedBlockIds: new Set(),
      primarySelectedBlockId: null,
      selectionMode: 'none',
      editingBlockId: null,
      selectionAnchor: null,
    });
  },
  
  // Select a single block (clearing previous selection)
  selectBlock: (blockId, includeChildren = true) => {
    const state = get();
    const selectedIds = new Set([blockId]);
    
    if (includeChildren) {
      const childIds = state.getAllChildrenIds(blockId);
      childIds.forEach(id => selectedIds.add(id));
    }
    
    // Update block states
    const newBlockStates = new Map(state.blockStates);
    // Clear all selected states
    newBlockStates.forEach((currentState, key) => {
      if (currentState === 'selected' || currentState === 'edit') {
        newBlockStates.set(key, 'display');
      }
    });
    // Set new selected block
    newBlockStates.set(blockId, 'selected');
    if (includeChildren) {
      state.getAllChildrenIds(blockId).forEach(id => {
        newBlockStates.set(id, 'selected');
      });
    }
    
    set({
      blockStates: newBlockStates,
      selectedBlockIds: selectedIds,
      primarySelectedBlockId: blockId,
      selectionMode: 'selected',
      editingBlockId: null,
      selectionAnchor: { blockId, direction: null },
    });
  },
  
  // Select multiple blocks
  selectBlocks: (blockIds) => {
    const selectedIds = new Set(blockIds);
    set({
      selectedBlockIds: selectedIds,
      primarySelectedBlockId: blockIds.length > 0 ? blockIds[0] : null,
      selectionMode: blockIds.length > 0 ? 'selected' : 'none',
      editingBlockId: null,
    });
  },
  
  // Select all blocks between two blocks in visual order
  selectBlocksInRange: (startId, endId) => {
    const state = get();
    const visibleBlocks = state.visibleBlockIds;
    const startIndex = visibleBlocks.indexOf(startId);
    const endIndex = visibleBlocks.indexOf(endId);
    
    if (startIndex === -1 || endIndex === -1) return;
    
    const minIndex = Math.min(startIndex, endIndex);
    const maxIndex = Math.max(startIndex, endIndex);
    
    const blockIdsInRange = visibleBlocks.slice(minIndex, maxIndex + 1);
    
    // Select all blocks in range, including their children
    const selectedIds = new Set<number>();
    const newBlockStates = new Map(state.blockStates);
    
    // Clear existing selected states
    newBlockStates.forEach((currentState, key) => {
      if (currentState === 'selected' || currentState === 'edit') {
        newBlockStates.set(key, 'display');
      }
    });
    
    for (const blockId of blockIdsInRange) {
      selectedIds.add(blockId);
      newBlockStates.set(blockId, 'selected');
      // Add all children
      const childIds = state.getAllChildrenIds(blockId);
      for (const childId of childIds) {
        selectedIds.add(childId);
        newBlockStates.set(childId, 'selected');
      }
    }
    
    set({
      blockStates: newBlockStates,
      selectedBlockIds: selectedIds,
      primarySelectedBlockId: blockIdsInRange[0],
      selectionMode: 'selected',
      editingBlockId: null,
      selectionAnchor: { blockId: blockIdsInRange[0], direction: null },
    });
  },
  
  // Add a block to current selection
  addToSelection: (blockId, includeChildren = true) => {
    const state = get();
    const newSelected = new Set(state.selectedBlockIds);
    newSelected.add(blockId);
    
    if (includeChildren) {
      const childIds = state.getAllChildrenIds(blockId);
      childIds.forEach(id => newSelected.add(id));
    }
    
    set({
      selectedBlockIds: newSelected,
      primarySelectedBlockId: state.primarySelectedBlockId ?? blockId,
      selectionMode: 'selected',
    });
  },
  
  // Remove a block from selection
  removeFromSelection: (blockId) => {
    const state = get();
    const newSelected = new Set(state.selectedBlockIds);
    newSelected.delete(blockId);
    
    // Also remove children
    const childIds = state.getAllChildrenIds(blockId);
    childIds.forEach(id => newSelected.delete(id));
    
    set({
      selectedBlockIds: newSelected,
      primarySelectedBlockId: newSelected.size > 0 
        ? (state.primarySelectedBlockId !== blockId ? state.primarySelectedBlockId : newSelected.values().next().value)
        : null,
      selectionMode: newSelected.size > 0 ? 'selected' : 'none',
    });
  },
  
  // Clear all selection
  clearSelection: () => {
    set({
      selectedBlockIds: new Set(),
      primarySelectedBlockId: null,
      selectionMode: 'none',
    });
  },
  
  // Toggle a block's selection
  toggleBlockSelection: (blockId) => {
    const state = get();
    if (state.selectedBlockIds.has(blockId)) {
      state.removeFromSelection(blockId);
    } else {
      state.addToSelection(blockId);
    }
  },
  
  // Enter edit mode for a block
  enterEditMode: (blockId) => {
    const state = get();
    const newBlockStates = new Map(state.blockStates);
    
    // Clear all edit and selected states
    newBlockStates.forEach((currentState, key) => {
      if (currentState === 'edit' || currentState === 'selected') {
        newBlockStates.set(key, 'display');
      }
    });
    newBlockStates.set(blockId, 'edit');
    
    set({
      blockStates: newBlockStates,
      editingBlockId: blockId,
      selectionMode: 'editing',
      selectedBlockIds: new Set(),
      primarySelectedBlockId: null,
      selectionAnchor: null,
    });
  },
  
  // Exit edit mode (select the block that was being edited)
  exitEditMode: () => {
    const state = get();
    if (state.editingBlockId) {
      state.selectBlock(state.editingBlockId);
    }
    set({ editingBlockId: null, editorSelection: null, pendingSelection: null });
  },
  
  // === Editor Selection Actions ===
  
  // Set the current editor selection
  setEditorSelection: (selection) => {
    set({ editorSelection: selection });
  },
  
  // Set pending selection to restore after mutations/re-renders
  setPendingSelection: (selection) => {
    set({ pendingSelection: selection });
  },
  
  // Clear pending selection after restoration
  clearPendingSelection: () => {
    set({ pendingSelection: null });
  },
  
  // Convenience: set pending caret at a specific block and offset
  setPendingCaret: (blockId, offset, caretX, clickCoords) => {
    set({
      pendingSelection: {
        anchorBlockId: blockId,
        anchorOffset: offset,
        focusBlockId: blockId,
        focusOffset: offset,
        caretX,
        clickX: clickCoords?.x,
        clickY: clickCoords?.y,
      },
    });
  },
  
  // Set selection mode directly
  setSelectionMode: (mode) => {
    set({ selectionMode: mode });
  },
  
  // Start dragging a block
  startDrag: (blockId) => {
    const state = get();
    const draggedIds = state.selectedBlockIds.has(blockId)
      ? Array.from(state.selectedBlockIds)
      : [blockId];
    
    set({
      dragState: {
        isDragging: true,
        draggedBlockId: blockId,
        draggedBlockIds: draggedIds,
        dropTargetId: null,
        dropPosition: null,
      },
    });
  },
  
  // Update drag target
  updateDragTarget: (targetId, position) => {
    set(state => ({
      dragState: {
        ...state.dragState,
        dropTargetId: targetId,
        dropPosition: position,
      },
    }));
  },
  
  // End dragging
  endDrag: () => {
    set({
      dragState: {
        isDragging: false,
        draggedBlockId: null,
        draggedBlockIds: [],
        dropTargetId: null,
        dropPosition: null,
      },
    });
  },
  
  // Start box selection
  startBoxSelect: (x, y) => {
    set({
      boxSelectState: {
        isBoxSelecting: true,
        startX: x,
        startY: y,
        currentX: x,
        currentY: y,
      },
    });
  },
  
  // Update box selection
  updateBoxSelect: (x, y) => {
    set(state => ({
      boxSelectState: {
        ...state.boxSelectState,
        currentX: x,
        currentY: y,
      },
    }));
  },
  
  // End box selection
  endBoxSelect: () => {
    set({
      boxSelectState: {
        isBoxSelecting: false,
        startX: 0,
        startY: 0,
        currentX: 0,
        currentY: 0,
      },
    });
  },
  
  // Start drag selection - called on mousedown on a block
  startDragSelect: (blockId) => {
    set({
      dragSelectState: {
        isDragSelecting: true,
        startBlockId: blockId,
      },
    });
    // Select the starting block
    get().selectBlock(blockId, true);
  },
  
  // Update drag selection - called on mouseenter on a block
  updateDragSelect: (blockId) => {
    const state = get();
    if (!state.dragSelectState.isDragSelecting) return;
    if (state.dragSelectState.startBlockId === null) return;
    
    // Select all blocks in range from start to current
    get().selectBlocksInRange(state.dragSelectState.startBlockId, blockId);
  },
  
  // End drag selection - called on mouseup
  endDragSelect: () => {
    set({
      dragSelectState: {
        isDragSelecting: false,
        startBlockId: null,
      },
    });
  },

  // Register a block element
  registerBlock: (blockId, element) => {
    const newMap = new Map(get().blockElements);
    newMap.set(blockId, element);
    set({ blockElements: newMap });
  },
  
  // Unregister a block element
  unregisterBlock: (blockId) => {
    const newMap = new Map(get().blockElements);
    newMap.delete(blockId);
    set({ blockElements: newMap });
  },
  
  // Set visible blocks (in order)
  setVisibleBlocks: (blockIds) => {
    set({ visibleBlockIds: blockIds });
  },
  
  // Set block hierarchy
  setBlockHierarchy: (parentMap, childrenMap) => {
    set({
      blockParentMap: parentMap,
      blockChildrenMap: childrenMap,
    });
  },
  
  // Get next block in a direction
  getNextBlockId: (currentId, direction) => {
    const state = get();
    const index = state.visibleBlockIds.indexOf(currentId);
    
    if (index === -1) return null;
    
    if (direction === 'up') {
      return index > 0 ? state.visibleBlockIds[index - 1] : null;
    } else {
      return index < state.visibleBlockIds.length - 1 
        ? state.visibleBlockIds[index + 1] 
        : null;
    }
  },
  
  // Get next sibling in a direction
  getNextSiblingId: (currentId, direction) => {
    const state = get();
    const parentId = state.blockParentMap.get(currentId);
    
    // Get siblings (blocks with same parent)
    const siblings = state.visibleBlockIds.filter(
      id => state.blockParentMap.get(id) === parentId
    );
    
    const index = siblings.indexOf(currentId);
    if (index === -1) return null;
    
    if (direction === 'up') {
      return index > 0 ? siblings[index - 1] : null;
    } else {
      return index < siblings.length - 1 ? siblings[index + 1] : null;
    }
  },
  
  // Get all children IDs recursively
  getAllChildrenIds: (blockId) => {
    const state = get();
    const result: number[] = [];
    const children = state.blockChildrenMap.get(blockId) || [];
    
    for (const childId of children) {
      result.push(childId);
      result.push(...state.getAllChildrenIds(childId));
    }
    
    return result;
  },
  
  // Extend selection using keyboard (Shift+Up/Down)
  extendSelectionKeyboard: (direction) => {
    const state = get();
    
    // If in edit mode, switch to selection mode first, then extend
    if (state.selectionMode === 'editing' && state.editingBlockId) {
      const blockIdToSelect = state.editingBlockId;
      state.selectBlock(blockIdToSelect);
      // After selecting, continue to extend the selection
      // Re-get state after selectBlock
      const newState = get();
      const nextBlockId = newState.getNextBlockId(blockIdToSelect, direction);
      if (nextBlockId !== null) {
        newState.addToSelection(nextBlockId);
        set({
          selectionAnchor: { blockId: blockIdToSelect, direction },
        });
      }
      return;
    }
    
    // If no selection, nothing to extend
    if (state.selectedBlockIds.size === 0 || !state.primarySelectedBlockId) {
      return;
    }
    
    const anchor = state.selectionAnchor;
    
    // Get the current anchor direction
    const currentDirection = anchor?.direction || null;
    
    // Determine which block to work from
    // If expanding in same direction, use the last added block
    // If contracting (opposite direction), remove blocks
    
    const visibleSelected = state.visibleBlockIds.filter(id => state.selectedBlockIds.has(id));
    
    if (visibleSelected.length === 0) return;
    
    // Get the boundary blocks in visible order
    const firstSelected = visibleSelected[0];
    const lastSelected = visibleSelected[visibleSelected.length - 1];
    
    // Determine the edge block based on direction
    const edgeBlockId = direction === 'up' ? firstSelected : lastSelected;
    const nextBlockId = state.getNextBlockId(edgeBlockId, direction);
    
    if (nextBlockId !== null) {
      // Check if we should expand or contract
      if (currentDirection === null || currentDirection === direction) {
        // Expand in this direction
        state.addToSelection(nextBlockId);
        set({
          selectionAnchor: { blockId: anchor?.blockId || state.primarySelectedBlockId!, direction },
        });
      } else {
        // Contract from the opposite direction
        const contractBlockId = direction === 'up' ? lastSelected : firstSelected;
        
        // Don't contract if it's the anchor
        if (contractBlockId !== anchor?.blockId && visibleSelected.length > 1) {
          state.removeFromSelection(contractBlockId);
          
          // If down to single selection, reset direction
          if (visibleSelected.length <= 2) {
            const anchorBlockId = anchor?.blockId ?? state.primarySelectedBlockId!;
            set({
              selectionAnchor: { blockId: anchorBlockId, direction: null },
            });
          }
        }
      }
    }
  },
  
  // === Operation Queue Implementation ===
  
  /**
   * Start tracking a structural operation.
   * Returns a unique operation ID for later completion.
   */
  startOperation: (type, blockIds, promise) => {
    const operationId = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    
    const entry: OperationQueueEntry = {
      id: operationId,
      type,
      blockIds,
      promise,
      startTime: Date.now(),
    };
    
    set((state) => {
      const newQueue = new Map(state.operationQueue);
      newQueue.set(operationId, entry);
      return { operationQueue: newQueue };
    });
    
    // Auto-cleanup when promise resolves or rejects
    promise.finally(() => {
      get().endOperation(operationId);
    });
    
    return operationId;
  },
  
  /**
   * End/complete an operation, removing it from the queue.
   */
  endOperation: (operationId) => {
    set((state) => {
      const newQueue = new Map(state.operationQueue);
      newQueue.delete(operationId);
      return { operationQueue: newQueue };
    });
  },
  
  /**
   * Check if there's any pending operation affecting the given blocks.
   */
  hasBlockingOperation: (blockIds) => {
    const state = get();
    const blockIdSet = new Set(blockIds);
    
    for (const entry of state.operationQueue.values()) {
      // Check if any of the entry's block IDs overlap with our block IDs
      for (const id of entry.blockIds) {
        if (blockIdSet.has(id)) {
          return true;
        }
      }
    }
    
    return false;
  },
  
  /**
   * Wait for all operations affecting the given blocks to complete.
   */
  waitForOperations: async (blockIds) => {
    const state = get();
    const blockIdSet = new Set(blockIds);
    const relevantPromises: Promise<void>[] = [];
    
    for (const entry of state.operationQueue.values()) {
      // Check if any of the entry's block IDs overlap with our block IDs
      for (const id of entry.blockIds) {
        if (blockIdSet.has(id)) {
          relevantPromises.push(entry.promise);
          break; // Only need to add the promise once per entry
        }
      }
    }
    
    if (relevantPromises.length > 0) {
      await Promise.all(relevantPromises);
    }
  },
  
  /**
   * Get all pending operations (for debugging/monitoring).
   */
  getPendingOperations: () => {
    return Array.from(get().operationQueue.values());
  },
}));
