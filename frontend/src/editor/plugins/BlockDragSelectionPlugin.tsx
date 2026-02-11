/**
 * BlockDragSelectionPlugin — Logseq-style vertical drag selection
 *
 * Behavior:
 * - Click on block content → edit mode, horizontal drag selects text
 * - Drag vertically beyond block bounds → switches to block selection
 * - Continue dragging → selects additional blocks (with their children)
 */

import { useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $setSelection } from 'lexical';

/**
 * Helper: Select a block and all its children (card-style selection)
 */
function selectBlockWithChildren(rootEl: HTMLElement, blockId: string, selectedBlocks: Set<string>) {
  const blockEl = rootEl.querySelector(`[data-block-id="${blockId}"]`) as HTMLElement;
  if (!blockEl) return;

  const blockDepth = parseInt(blockEl.getAttribute('data-depth') || '0', 10);
  const allBlocks = Array.from(rootEl.querySelectorAll('[data-block-id]')) as HTMLElement[];
  const blockIndex = allBlocks.indexOf(blockEl);
  
  // Add the block itself
  selectedBlocks.add(blockId);
  blockEl.classList.add('node-block--selected');
  
  // Find and add all children (blocks with greater depth that follow)
  const children: HTMLElement[] = [];
  for (let i = blockIndex + 1; i < allBlocks.length; i++) {
    const nextBlock = allBlocks[i];
    const nextDepth = parseInt(nextBlock.getAttribute('data-depth') || '0', 10);
    
    // Stop when we hit a block at same or lesser depth
    if (nextDepth <= blockDepth) break;
    
    const nextBlockId = nextBlock.getAttribute('data-block-id');
    if (nextBlockId) {
      selectedBlocks.add(nextBlockId);
      nextBlock.classList.add('node-block--selected-child');
      children.push(nextBlock);
    }
  }
  
  // Apply first/last/single classes for proper card styling
  if (children.length === 0) {
    blockEl.classList.add('node-block--selected-single');
  } else {
    blockEl.classList.add('node-block--selected-first');
    children[children.length - 1].classList.add('node-block--selected-last');
  }
}

/**
 * Helper: Clear all selection classes
 */
function clearBlockSelection(rootEl: HTMLElement) {
  rootEl.querySelectorAll('.node-block--selected, .node-block--selected-child, .node-block--selected-first, .node-block--selected-last, .node-block--selected-single').forEach(el => {
    el.classList.remove('node-block--selected', 'node-block--selected-child', 'node-block--selected-first', 'node-block--selected-last', 'node-block--selected-single');
  });
}

export interface BlockDragSelectionPluginProps {
  editorId: string;
  readOnly?: boolean;
  onSelectionChange?: (selectedBlockIds: string[]) => void;
}

export function BlockDragSelectionPlugin({
  editorId: _editorId,
  readOnly,
  onSelectionChange,
}: BlockDragSelectionPluginProps): null {
  const [editor] = useLexicalComposerContext();
  
  const isDragging = useRef(false);
  const isBlockSelectionMode = useRef(false);
  const dragStartPoint = useRef<{ x: number; y: number } | null>(null);
  const dragStartBlock = useRef<HTMLElement | null>(null);
  const selectedBlocks = useRef<Set<string>>(new Set());
  const lastHoveredBlock = useRef<string | null>(null);
  const justCompletedDrag = useRef(false);

  // Store ref to clear selections function accessible by other plugins
  useEffect(() => {
    const rootEl = editor.getRootElement();
    if (!rootEl) return;
    
    // Make it accessible for other selection mechanisms
    (rootEl as any).__clearBlockSelection = () => {
      clearBlockSelection(rootEl);
      selectedBlocks.current.clear();
    };
    
    return () => {
      delete (rootEl as any).__clearBlockSelection;
    };
  }, [editor]);

  useEffect(() => {
    if (readOnly) return;

    const rootEl = editor.getRootElement();
    if (!rootEl) return;

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      
      // Ignore clicks on bullets or collapse arrows
      if (target.closest('.node-block-bullet') || target.closest('.node-block-collapse-arrow')) {
        return;
      }

      // Only start tracking if clicking on block content
      const blockEl = target.closest('[data-block-id]') as HTMLElement;
      if (!blockEl) return;

      // Clear previous block selection only if:
      // 1. Not shift-clicking AND
      // 2. Not just completing a drag operation
      if (!e.shiftKey && !justCompletedDrag.current) {
        clearBlockSelection(rootEl);
        selectedBlocks.current.clear();
      }
      
      justCompletedDrag.current = false;

      isDragging.current = true;
      isBlockSelectionMode.current = false;
      dragStartPoint.current = { x: e.clientX, y: e.clientY };
      dragStartBlock.current = blockEl;
      lastHoveredBlock.current = null;
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !dragStartPoint.current || !dragStartBlock.current) return;

      const deltaX = Math.abs(e.clientX - dragStartPoint.current.x);
      const deltaY = Math.abs(e.clientY - dragStartPoint.current.y);
      const blockRect = dragStartBlock.current.getBoundingClientRect();

      // Check if we've exited the block boundaries vertically
      const hasExitedBlock = e.clientY < blockRect.top || e.clientY > blockRect.bottom;

      // Switch to block selection mode if:
      // 1. We've moved vertically more than horizontally AND
      // 2. We've moved vertically beyond threshold (15px) AND
      // 3. We've exited the starting block boundaries
      if (!isBlockSelectionMode.current && deltaY > deltaX && deltaY > 15 && hasExitedBlock) {
        isBlockSelectionMode.current = true;
        
        // Clear text selection and prevent further text selection
        const selection = window.getSelection();
        if (selection) {
          selection.removeAllRanges();
        }
        
        editor.update(() => {
          $setSelection(null);
        });
        
        // Select the starting block with its children (after Lexical updates)
        const startBlockId = dragStartBlock.current.getAttribute('data-block-id');
        if (startBlockId && rootEl) {
          setTimeout(() => {
            clearBlockSelection(rootEl);
            selectedBlocks.current.clear();
            selectBlockWithChildren(rootEl, startBlockId, selectedBlocks.current);
            onSelectionChange?.([...selectedBlocks.current]);
          }, 0);
        }
      }

      // If in block selection mode, handle block hovering
      if (isBlockSelectionMode.current && rootEl) {
        const target = e.target as HTMLElement;
        const hoveredBlock = target.closest('[data-block-id]') as HTMLElement | null;
        
        if (hoveredBlock) {
          const hoveredBlockId = hoveredBlock.getAttribute('data-block-id');
          
          if (hoveredBlockId && hoveredBlockId !== lastHoveredBlock.current) {
            lastHoveredBlock.current = hoveredBlockId;
            
            // Add to selection if not already selected (with children)
            if (!selectedBlocks.current.has(hoveredBlockId)) {
              selectBlockWithChildren(rootEl, hoveredBlockId, selectedBlocks.current);
              onSelectionChange?.([...selectedBlocks.current]);
            }
          }
        }
      }
    };

    const handleMouseUp = () => {
      if (!isDragging.current) return;

      // If we ended in block selection mode, keep blocks selected
      if (isBlockSelectionMode.current && selectedBlocks.current.size > 0) {
        onSelectionChange?.([...selectedBlocks.current]);
        // Keep the .node-block--selected class on the blocks
        justCompletedDrag.current = true;
        // Reset flag after click event has had time to fire (click fires ~100ms after mouseup)
        setTimeout(() => {
          justCompletedDrag.current = false;
        }, 150);
      }
      // Note: Don't clear selection here - it was already cleared on mousedown if needed

      // Clean up drag state
      isDragging.current = false;
      isBlockSelectionMode.current = false;
      dragStartPoint.current = null;
      dragStartBlock.current = null;
      lastHoveredBlock.current = null;
    };

    const handleMouseLeave = () => {
      // If mouse leaves editor while dragging, end the drag
      if (isDragging.current) {
        handleMouseUp();
      }
    };

    rootEl.addEventListener('mousedown', handleMouseDown);
    rootEl.addEventListener('mousemove', handleMouseMove);
    rootEl.addEventListener('mouseup', handleMouseUp);
    rootEl.addEventListener('mouseleave', handleMouseLeave);

    return () => {
      rootEl.removeEventListener('mousedown', handleMouseDown);
      rootEl.removeEventListener('mousemove', handleMouseMove);
      rootEl.removeEventListener('mouseup', handleMouseUp);
      rootEl.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, [editor, readOnly, onSelectionChange]);

  return null;
}
