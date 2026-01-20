/**
 * useBlockSelection Hook
 * 
 * Provides keyboard navigation and selection management for blocks.
 * Features:
 * - Escape to exit edit mode and select block
 * - Up/Down arrows to navigate between blocks
 * - Shift+Up/Down to extend selection
 * - Track visible blocks and their hierarchy
 */
import { useEffect, useCallback, useRef } from 'react';
import { useBlockSelectionStore } from '@/stores/blockSelectionStore';
import type { Node } from '@/types';

interface UseBlockSelectionOptions {
  /** Parent container ref for scoping events */
  containerRef?: React.RefObject<HTMLElement | null>;
  /** Whether selection is enabled */
  enabled?: boolean;
}

/**
 * Build a flat list of visible block IDs and their hierarchy
 */
function buildBlockHierarchy(
  blocks: Node[],
  parentId: number | null = null
): {
  flatIds: number[];
  parentMap: Map<number, number | null>;
  childrenMap: Map<number, number[]>;
} {
  const flatIds: number[] = [];
  const parentMap = new Map<number, number | null>();
  const childrenMap = new Map<number, number[]>();
  
  function traverse(nodes: Node[], parent: number | null) {
    for (const node of nodes) {
      flatIds.push(node.id);
      parentMap.set(node.id, parent);
      
      const childIds = (node.children || []).map(c => c.id);
      childrenMap.set(node.id, childIds);
      
      if (node.children && node.children.length > 0) {
        traverse(node.children, node.id);
      }
    }
  }
  
  traverse(blocks, parentId);
  return { flatIds, parentMap, childrenMap };
}

/**
 * Hook for managing block selection and keyboard navigation
 */
export function useBlockSelection(
  blocks: Node[],
  options: UseBlockSelectionOptions = {}
) {
  const { containerRef, enabled = true } = options;
  
  const {
    selectedBlockIds,
    primarySelectedBlockId,
    selectionMode,
    editingBlockId,
    selectBlock,
    addToSelection,
    clearSelection,
    exitEditMode,
    setVisibleBlocks,
    setBlockHierarchy,
    getNextBlockId,
    getNextSiblingId,
    blockElements,
  } = useBlockSelectionStore();
  
  // Track previous block IDs to detect structural changes
  const prevBlockIdsRef = useRef<string>('');
  
  // Update block hierarchy when blocks change
  useEffect(() => {
    if (!enabled) return;
    
    // Only update if blocks actually changed (compare IDs, not references)
    const currentBlockIds = blocks.map(b => b.id).join(',');
    const blocksChanged = currentBlockIds !== prevBlockIdsRef.current;
    if (!blocksChanged) return;
    
    prevBlockIdsRef.current = currentBlockIds;
    
    const { flatIds, parentMap, childrenMap } = buildBlockHierarchy(blocks);
    setVisibleBlocks(flatIds);
    setBlockHierarchy(parentMap, childrenMap);
  }, [blocks, enabled, setBlockHierarchy, setVisibleBlocks]);
  
  /**
   * Focus a block's editor element
   */
  const focusBlock = useCallback((blockId: number) => {
    const element = blockElements.get(blockId);
    if (element) {
      // Find the textarea within the block
      const textarea = element.querySelector('textarea');
      if (textarea) {
        textarea.focus();
      } else {
        // Fallback to focusing the element itself
        element.focus();
      }
      
      // Scroll into view if needed
      element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [blockElements]);
  
  /**
   * Navigate to an adjacent block
   */
  const navigateToBlock = useCallback((direction: 'up' | 'down') => {
    const currentId = primarySelectedBlockId ?? editingBlockId;
    if (!currentId) return;
    
    const nextId = getNextBlockId(currentId, direction);
    if (nextId) {
      selectBlock(nextId);
      focusBlock(nextId);
    }
  }, [editingBlockId, focusBlock, getNextBlockId, primarySelectedBlockId, selectBlock]);
  
  /**
   * Extend selection to adjacent block
   */
  const extendSelection = useCallback((direction: 'up' | 'down') => {
    const currentId = primarySelectedBlockId ?? editingBlockId;
    if (!currentId) return;
    
    // First, select the current block if not already in selection mode
    if (selectionMode !== 'selected') {
      selectBlock(currentId);
    }
    
    // For down direction, only select siblings
    if (direction === 'down') {
      const nextSiblingId = getNextSiblingId(currentId, 'down');
      if (nextSiblingId) {
        addToSelection(nextSiblingId);
      }
    } else {
      // For up direction, select the previous visible block
      const prevId = getNextBlockId(currentId, 'up');
      if (prevId) {
        addToSelection(prevId);
      }
    }
  }, [addToSelection, editingBlockId, getNextBlockId, getNextSiblingId, primarySelectedBlockId, selectBlock, selectionMode]);
  
  /**
   * Handle keyboard events for block navigation
   */
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!enabled) return;
    
    // Check if the event target is within our container
    if (containerRef?.current && !containerRef.current.contains(e.target as HTMLElement)) {
      return;
    }
    
    // Escape: exit edit mode and select the block
    if (e.key === 'Escape') {
      if (editingBlockId) {
        e.preventDefault();
        exitEditMode();
      } else if (selectedBlockIds.size > 0) {
        e.preventDefault();
        clearSelection();
      }
      return;
    }
    
    // Arrow navigation (only when in selection mode, not editing)
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && selectionMode === 'selected') {
      const direction = e.key === 'ArrowUp' ? 'up' : 'down';
      
      if (e.shiftKey) {
        // Shift+Arrow extends selection
        e.preventDefault();
        extendSelection(direction);
      } else {
        // Arrow navigates
        e.preventDefault();
        navigateToBlock(direction);
      }
    }
    
    // Delete selected blocks
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectionMode === 'selected' && !editingBlockId) {
      // This could trigger deletion, but we'll let the parent component handle it
      // Just dispatch a custom event
      const event = new CustomEvent('delete-selected-blocks', {
        detail: { blockIds: Array.from(selectedBlockIds) }
      });
      window.dispatchEvent(event);
    }
  }, [
    clearSelection,
    containerRef,
    editingBlockId,
    enabled,
    exitEditMode,
    extendSelection,
    navigateToBlock,
    selectedBlockIds,
    selectionMode,
  ]);
  
  // Add global keyboard listener
  useEffect(() => {
    if (!enabled) return;
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, handleKeyDown]);
  
  // Click outside to clear selection
  useEffect(() => {
    if (!enabled) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      
      // Check if click is outside all blocks
      const isInsideBlock = target.closest('[data-block-id]');
      const isInsideContainer = containerRef?.current?.contains(target);
      
      if (!isInsideBlock && isInsideContainer) {
        // Clicked on empty space within container
        clearSelection();
      }
    };
    
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [clearSelection, containerRef, enabled]);
  
  return {
    selectedBlockIds,
    primarySelectedBlockId,
    selectionMode,
    editingBlockId,
    selectBlock,
    clearSelection,
    navigateToBlock,
    extendSelection,
    focusBlock,
  };
}

export default useBlockSelection;
