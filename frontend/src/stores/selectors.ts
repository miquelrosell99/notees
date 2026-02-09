/**
 * Zustand Selectors for Performance
 * 
 * Fine-grained selectors that prevent render cascades.
 * 
 * RULE: Never subscribe to entire collections (nodes, nodeMap).
 * Instead, use these targeted selectors that return stable references.
 * 
 * WHY THIS MATTERS:
 * - Broad subscriptions cause ALL node components to re-render on ANY change
 * - Selectors with stable identity only trigger re-renders when relevant data changes
 * - Derived values computed in selectors prevent inline recomputation
 * 
 * NOTE ON ACTIONS:
 * - For selectors returning only actions (no state), use getState() instead
 * - Actions are stable references and don't need reactive subscriptions
 */
import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useNodesStore } from './nodesStore';
import { useBlockSelectionStore } from './blockSelectionStore';
import type { Node } from '@/types';

// ==================== NodesStore Selectors ====================

/**
 * Select current node ID only - minimal subscription
 */
export function useCurrentNodeId() {
  return useNodesStore(state => state.currentNodeId);
}

/**
 * Select current node type (page vs block)
 */
export function useCurrentNodeType() {
  return useNodesStore(state => state.currentNodeType);
}

/**
 * Select view mode only
 */
export function useViewMode() {
  return useNodesStore(state => state.viewMode);
}

/**
 * Check if currently in focused view mode
 */
export function useIsFocusedMode() {
  return useNodesStore(state => state.currentNodeType === 'block');
}

/**
 * Select sidebar state only - uses shallow comparison for object
 */
export function useSidebarState() {
  return useNodesStore(
    useShallow(state => ({
      sidebarOpen: state.sidebarOpen,
      rightSidebarOpen: state.rightSidebarOpen,
      isSidebarCollapsed: state.isSidebarCollapsed,
    }))
  );
}

/**
 * Select display mode (document/bullet/card)
 */
export function useContentDisplayMode() {
  return useNodesStore(state => state.contentDisplayMode);
}

// ==================== BlockSelectionStore Selectors ====================

/**
 * Check if a specific block is selected - STABLE per block
 * 
 * CRITICAL: Use this instead of selectedBlockIds.has(id) in components
 * Returns a stable boolean that only changes when THIS block's selection changes
 */
export function useIsBlockSelected(blockId: number): boolean {
  return useBlockSelectionStore(
    useCallback(state => state.selectedBlockIds.has(blockId), [blockId])
  );
}

/**
 * Check if a specific block is the primary selection
 */
export function useIsPrimarySelected(blockId: number): boolean {
  return useBlockSelectionStore(
    useCallback(state => state.primarySelectedBlockId === blockId, [blockId])
  );
}

/**
 * Check if a block is a "selection root" - selected but parent is NOT selected.
 * This is used to render the selection Card only on the topmost selected block in a tree,
 * so that children don't show nested selection cards.
 */
export function useIsSelectionRoot(blockId: number, parentId: number | null | undefined): boolean {
  return useBlockSelectionStore(
    useCallback(state => {
      // Block must be selected
      if (!state.selectedBlockIds.has(blockId)) return false;
      // If no parent, it's a root
      if (parentId === null || parentId === undefined) return true;
      // If parent is NOT selected, this is a selection root
      return !state.selectedBlockIds.has(parentId);
    }, [blockId, parentId])
  );
}

/**
 * Check if drag selection is currently active
 * Used by Block component to determine if it should respond to mouseenter
 */
export function useIsDragSelecting(): boolean {
  return useBlockSelectionStore(
    state => state.dragSelectState.isDragSelecting
  );
}

/**
 * Get block state (display/edit/selected) for a specific block
 * 
 * CRITICAL: Use this instead of getBlockState in render
 * The selector approach ensures stable reference
 */
export function useBlockState(blockId: number) {
  return useBlockSelectionStore(
    useCallback(state => state.blockStates.get(blockId) ?? 'display', [blockId])
  );
}

/**
 * Check if a specific block is being dragged
 */
export function useIsBlockDragging(blockId: number): boolean {
  return useBlockSelectionStore(
    useCallback(state => state.dragState.draggedBlockIds.includes(blockId), [blockId])
  );
}

/**
 * Get selection mode (none/editing/selected)
 */
export function useSelectionMode() {
  return useBlockSelectionStore(state => state.selectionMode);
}

/**
 * Get editing block ID (stable reference)
 */
export function useEditingBlockId() {
  return useBlockSelectionStore(state => state.editingBlockId);
}

/**
 * Get pending selection for restoration
 */
export function usePendingSelection() {
  return useBlockSelectionStore(state => state.pendingSelection);
}

/**
 * Get pending selection for a specific block (only returns if it's for this block)
 */
export function usePendingSelectionForBlock(blockId: number) {
  return useBlockSelectionStore(
    useCallback(
      state => state.pendingSelection?.anchorBlockId === blockId ? state.pendingSelection : null,
      [blockId]
    )
  );
}

/**
 * Get editor selection actions
 * 
 * NOTE: Actions are stable - we use getState() to avoid subscription overhead.
 * These functions don't change, so no need for reactive updates.
 */
export function useEditorSelectionActions() {
  // Return stable action references directly from getState()
  // This avoids the infinite loop from returning new objects in selectors
  const state = useBlockSelectionStore.getState();
  return {
    setEditorSelection: state.setEditorSelection,
    setPendingSelection: state.setPendingSelection,
    clearPendingSelection: state.clearPendingSelection,
    setPendingCaret: state.setPendingCaret,
  };
}

/**
 * Get operation queue actions for structural operations
 * Use these to coordinate async mutations and prevent race conditions
 */
export function useOperationQueueActions() {
  const state = useBlockSelectionStore.getState();
  return {
    startOperation: state.startOperation,
    endOperation: state.endOperation,
    hasBlockingOperation: state.hasBlockingOperation,
    waitForOperations: state.waitForOperations,
    getPendingOperations: state.getPendingOperations,
  };
}

/**
 * Check if ANY block is currently being edited
 */
export function useIsAnyBlockEditing(): boolean {
  return useBlockSelectionStore(state => state.editingBlockId !== null);
}

// ==================== Derived Selectors ====================

/**
 * Get selected block count - stable number
 */
export function useSelectedBlockCount(): number {
  return useBlockSelectionStore(state => state.selectedBlockIds.size);
}

/**
 * Check if multiple blocks are selected
 */
export function useIsMultiSelect(): boolean {
  return useBlockSelectionStore(state => state.selectedBlockIds.size > 1);
}

// ==================== Action Selectors ====================
// These return only actions, preventing re-renders on state changes

/**
 * Get node navigation action only
 */
export function useOpenNodeAction() {
  return useNodesStore(state => state.openNode);
}

/**
 * Get sidebar card action only
 */
export function useAddSidebarCardAction() {
  return useNodesStore(state => state.addSidebarCard);
}

/**
 * Get block selection actions only
 * Uses getState() since actions are stable references
 */
export function useBlockSelectionActions() {
  const state = useBlockSelectionStore.getState();
  return {
    selectBlock: state.selectBlock,
    addToSelection: state.addToSelection,
    clearSelection: state.clearSelection,
    setBlockState: state.setBlockState,
  };
}

/**
 * Get block navigation actions
 * Uses getState() since these are action functions that don't need reactive subscriptions
 */
export function useBlockNavigationActions() {
  const state = useBlockSelectionStore.getState();
  return {
    getNextBlockId: state.getNextBlockId,
    getNextSiblingId: state.getNextSiblingId,
    getAllChildrenIds: state.getAllChildrenIds,
  };
}

/**
 * Get visible block IDs for navigation computations
 * Note: This IS reactive since the list can change
 */
export function useVisibleBlockIds() {
  return useBlockSelectionStore(state => state.visibleBlockIds);
}

/**
 * Get block parent map for hierarchy lookups
 * Note: This IS reactive since it tracks current tree structure
 */
export function useBlockParentMap() {
  return useBlockSelectionStore(state => state.blockParentMap);
}

// ==================== Equality Functions ====================

/**
 * Shallow compare for array selectors
 */
export function shallowArrayEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Compare node by ID only (for memoization)
 */
export function nodeIdEqual(a: Node | null, b: Node | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id;
}

// ==================== Export ====================

export {
  // Re-export stores for direct access when needed
  useNodesStore,
  useBlockSelectionStore,
};
