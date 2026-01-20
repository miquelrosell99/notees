/**
 * Block Selection Store
 * 
 * Manages state for:
 * - Block states: display, edit, selected (mutually exclusive)
 * - Selection mode
 * - Drag and drop state
 * - Box selection
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
 */
import { create } from 'zustand';

export type BlockState = 'display' | 'edit' | 'selected';
export type SelectionMode = 'editing' | 'selected' | 'none';

/** Direction of selection expansion for keyboard navigation */
export type SelectionDirection = 'up' | 'down' | null;

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

/** Anchor block for keyboard range selection */
export interface SelectionAnchor {
  blockId: number;
  direction: SelectionDirection;
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
  
  // Drag state
  dragState: DragState;
  
  // Box selection state
  boxSelectState: BoxSelectState;
  
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
  addToSelection: (blockId: number, includeChildren?: boolean) => void;
  removeFromSelection: (blockId: number) => void;
  clearSelection: () => void;
  toggleBlockSelection: (blockId: number) => void;
  
  // Selection mode
  enterEditMode: (blockId: number) => void;
  exitEditMode: () => void;
  setSelectionMode: (mode: SelectionMode) => void;
  
  // Drag and drop
  startDrag: (blockId: number) => void;
  updateDragTarget: (targetId: number | null, position: 'before' | 'after' | 'inside' | null) => void;
  endDrag: () => void;
  
  // Box selection
  startBoxSelect: (x: number, y: number) => void;
  updateBoxSelect: (x: number, y: number) => void;
  endBoxSelect: () => void;
  
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
}

export const useBlockSelectionStore = create<BlockSelectionState>()((set, get) => ({
  blockStates: new Map(),
  selectedBlockIds: new Set(),
  primarySelectedBlockId: null,
  selectionMode: 'none',
  editingBlockId: null,
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
    set({ editingBlockId: null });
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
    
    const selectedArray = Array.from(state.selectedBlockIds);
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
            set({
              selectionAnchor: { blockId: anchor?.blockId!, direction: null },
            });
          }
        }
      }
    }
  },
}));
