/**
 * BlockDragSelectionPlugin — Logseq-style vertical drag selection
 *
 * Behavior:
 * - Click on block content → edit mode, horizontal drag selects text
 * - Drag vertically beyond block bounds → switches to block selection
 * - Continue dragging → selects additional blocks (with their children)
 */

import { useEffect, useRef, useCallback } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $setSelection } from 'lexical';
import { selectBlockWithChildren, clearBlockSelection } from '../utils/selectionUtils';

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

  // Expose clear function for other plugins via a stable callback
  const clearSelection = useCallback(() => {
    const rootEl = editor.getRootElement();
    if (rootEl) {
      clearBlockSelection(rootEl);
      selectedBlocks.current.clear();
    }
  }, [editor]);

  // Store clear function on the editor instance (typed, not on DOM)
  useEffect(() => {
    (editor as any).__clearBlockSelection = clearSelection;
    return () => {
      delete (editor as any).__clearBlockSelection;
    };
  }, [editor, clearSelection]);

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

      // Clear previous block selection unless shift-clicking or just completed a drag
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

      // Switch to block selection mode if vertical drag beyond block bounds
      if (!isBlockSelectionMode.current && deltaY > deltaX && deltaY > 15 && hasExitedBlock) {
        isBlockSelectionMode.current = true;
        
        // Clear text selection
        window.getSelection()?.removeAllRanges();
        editor.update(() => {
          $setSelection(null);
        });
        
        // Select the starting block with its children
        const startBlockId = dragStartBlock.current.getAttribute('data-block-id');
        if (startBlockId) {
          clearBlockSelection(rootEl);
          selectedBlocks.current.clear();
          selectBlockWithChildren(rootEl, startBlockId, selectedBlocks.current);
          onSelectionChange?.([...selectedBlocks.current]);
        }
      }

      // If in block selection mode, handle block hovering
      if (isBlockSelectionMode.current) {
        const target = e.target as HTMLElement;
        const hoveredBlock = target.closest('[data-block-id]') as HTMLElement | null;
        
        if (hoveredBlock) {
          const hoveredBlockId = hoveredBlock.getAttribute('data-block-id');
          
          if (hoveredBlockId && hoveredBlockId !== lastHoveredBlock.current) {
            lastHoveredBlock.current = hoveredBlockId;
            
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

      if (isBlockSelectionMode.current && selectedBlocks.current.size > 0) {
        onSelectionChange?.([...selectedBlocks.current]);
        justCompletedDrag.current = true;
        // Use requestAnimationFrame instead of setTimeout — fires after current event cycle
        requestAnimationFrame(() => {
          justCompletedDrag.current = false;
        });
      }

      isDragging.current = false;
      isBlockSelectionMode.current = false;
      dragStartPoint.current = null;
      dragStartBlock.current = null;
      lastHoveredBlock.current = null;
    };

    const handleMouseLeave = () => {
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
