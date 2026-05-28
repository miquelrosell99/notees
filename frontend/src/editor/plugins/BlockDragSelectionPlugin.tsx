/**
 * BlockDragSelectionPlugin — Logseq-style vertical drag selection
 *
 * Behavior:
 * - Bullet drag → handled by DragDropPlugin (block move/restructure), not here
 * - Content drag in edit mode, within block → text selection (browser native)
 * - Content drag in non-edit mode, within block → nothing (text selection suppressed)
 * - Content drag exiting block boundary (either mode) → block selection
 * - Continue dragging → selects additional blocks (with their children)
 */

import { useEffect, useRef, useCallback } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $setSelection } from 'lexical';
import { selectBlockWithChildren, clearBlockSelection } from '../utils/selectionUtils';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';
import { useInputContext } from '../../stores/inputContext';

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
  const startedInEditMode = useRef(false);
  const dragStartPoint = useRef<{ x: number; y: number } | null>(null);
  const dragStartBlock = useRef<HTMLElement | null>(null);
  const selectedBlocks = useRef<Set<string>>(new Set());
  const lastHoveredBlock = useRef<string | null>(null);
  const justCompletedDrag = useRef(false);
  const dragRafId = useRef<number | null>(null);

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
      // Don't start drag selection when a modal/popup is open
      if (useInputContext.getState().isOverlayOpen) return;
      const target = e.target as HTMLElement;
      
      // Ignore clicks on bullets or collapse arrows
      if (target.closest('.bullet-wrapper') || target.closest('.bullet-collapse-arrow')) {
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
      startedInEditMode.current = blockEl.classList.contains('node-block--editing');
      dragStartPoint.current = { x: e.clientX, y: e.clientY };
      dragStartBlock.current = blockEl;
      lastHoveredBlock.current = null;
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !dragStartPoint.current || !dragStartBlock.current) return;

      // Batch drag-selection updates with requestAnimationFrame to avoid
      // expensive DOM queries (selectBlockWithChildren) on every pixel
      if (dragRafId.current !== null) cancelAnimationFrame(dragRafId.current);
      
      dragRafId.current = requestAnimationFrame(() => {
        dragRafId.current = null;
        if (!isDragging.current || !dragStartPoint.current || !dragStartBlock.current) return;

        const deltaY = Math.abs(e.clientY - dragStartPoint.current.y);

        // Outside edit mode: suppress any browser text selection while dragging
        if (!startedInEditMode.current && !isBlockSelectionMode.current) {
          window.getSelection()?.removeAllRanges();
        }

        // Block selection triggers when the cursor exits the starting block's
        // vertical bounds, regardless of edit mode.
        if (!isBlockSelectionMode.current) {
          const blockRect = dragStartBlock.current!.getBoundingClientRect();
          const hasExitedBlock = e.clientY < blockRect.top || e.clientY > blockRect.bottom;

          if (hasExitedBlock && deltaY > 5) {
            isBlockSelectionMode.current = true;

            // Clear text selection and Lexical selection
            window.getSelection()?.removeAllRanges();
            editor.update(() => {
              $setSelection(null);
            });

            // Blur editor so custom caret hides immediately
            editor.blur();
            const activeEl = document.activeElement;
            if (activeEl && rootEl.contains(activeEl) && activeEl !== rootEl) {
              (activeEl as HTMLElement).blur();
            }

            // Select the starting block with its children
            const startBlockId = dragStartBlock.current!.getAttribute('data-block-id');
            if (startBlockId) {
              clearBlockSelection(rootEl);
              selectedBlocks.current.clear();
              selectBlockWithChildren(rootEl, startBlockId, selectedBlocks.current);
              onSelectionChange?.([...selectedBlocks.current]);
            }
          }
        }

        // If in block selection mode, handle block hovering
        if (isBlockSelectionMode.current) {
          const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
          const hoveredBlock = target?.closest('[data-block-id]') as HTMLElement | null;
          
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
      });
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
        // Blur editor so custom caret hides and editing state is removed
        editor.blur();
        const activeEl = document.activeElement;
        if (activeEl && rootEl.contains(activeEl) && activeEl !== rootEl) {
          (activeEl as HTMLElement).blur();
        }
      }

      isDragging.current = false;
      isBlockSelectionMode.current = false;
      dragStartPoint.current = null;
      dragStartBlock.current = null;
      lastHoveredBlock.current = null;
    };

    rootEl.addEventListener('mousedown', handleMouseDown);
    // mousemove/mouseup on document — rootEl has pointer-events:none so
    // mouse events stop firing when the cursor is between blocks
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    // Document-level click: clear block selection when clicking outside selected blocks
    const handleDocumentMouseDown = (e: MouseEvent) => {
      // Skip if no selection to clear
      if (selectedBlocks.current.size === 0) return;
      
      const target = e.target as HTMLElement;
      
      // Check if click is inside a selected block — if so, don't clear
      const clickedBlock = target.closest('[data-block-id]') as HTMLElement | null;
      if (clickedBlock) {
        const blockId = clickedBlock.getAttribute('data-block-id');
        if (blockId && selectedBlocks.current.has(blockId)) return;
      }
      
      // Click is outside all selected blocks — clear selection
      clearBlockSelection(rootEl);
      selectedBlocks.current.clear();
      onSelectionChange?.([]);
    };

    // Document-level Delete/Backspace to delete drag-selected blocks
    const handleDeleteKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (selectedBlocks.current.size === 0) return;

      // If editor has focus, let Lexical handle it
      if (rootEl.contains(document.activeElement)) return;

      // Don't delete blocks while a dialog/menu is open
      if (document.activeElement?.closest('[role="dialog"]') || document.activeElement?.closest('[role="menu"]')) return;

      e.preventDefault();
      const blockIds = [...selectedBlocks.current];

      clearBlockSelection(rootEl);
      selectedBlocks.current.clear();
      onSelectionChange?.([]);

      const runtime = getNodeGraphRuntime();
      runtime.applyIntent({
        type: 'batch',
        intents: blockIds.map(blockId => ({ type: 'delete_block' as const, blockId })),
      });
      runtime.flushEvents();
    };

    document.addEventListener('keydown', handleDeleteKey);
    document.addEventListener('mousedown', handleDocumentMouseDown);

    return () => {
      rootEl.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('keydown', handleDeleteKey);
      document.removeEventListener('mousedown', handleDocumentMouseDown);
      if (dragRafId.current !== null) {
        cancelAnimationFrame(dragRafId.current);
        dragRafId.current = null;
      }
    };
  }, [editor, readOnly, onSelectionChange]);

  return null;
}
