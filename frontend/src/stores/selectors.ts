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
 */
import { useCallback } from 'react';
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
 * Select sidebar state only
 */
export function useSidebarState() {
  return useNodesStore(
    useCallback(state => ({
      sidebarOpen: state.sidebarOpen,
      rightSidebarOpen: state.rightSidebarOpen,
      isSidebarCollapsed: state.isSidebarCollapsed,
    }), [])
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
 */
export function useBlockSelectionActions() {
  return useBlockSelectionStore(
    useCallback(state => ({
      selectBlock: state.selectBlock,
      addToSelection: state.addToSelection,
      clearSelection: state.clearSelection,
      setBlockState: state.setBlockState,
    }), [])
  );
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
