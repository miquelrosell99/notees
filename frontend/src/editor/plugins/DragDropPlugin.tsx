/**
 * DragDropPlugin — Custom mouse-based drag & drop for blocks.
 *
 * Uses mousedown/mousemove/mouseup instead of native HTML5 drag API
 * to avoid contentEditable interference, ensure drops work in empty
 * space, and enable cross-editor drags (sidebar ↔ main).
 *
 * Lexical editors never move nodes themselves. They emit drag intents
 * to the DragCoordinator, which delegates to NodeGraphRuntime.
 */

import { useEffect, useCallback, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { getDragCoordinator } from '../../runtime/DragCoordinator';
import type { DropTarget } from '../../runtime/types';

export interface DragDropPluginProps {
  editorId: string;
  readOnly?: boolean;
}

/** Minimum pixels of mouse movement before drag activates */
const DRAG_THRESHOLD = 5;

/**
 * Given any element inside a block, find the closest `.node-block[data-block-id]` row.
 */
function findBlockRow(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null;
  return el.closest('.node-block[data-block-id]') as HTMLElement | null;
}

/**
 * Find the closest block row to a Y coordinate within an editor root.
 * Returns the last block if y is below all blocks. Returns null if no blocks.
 */
function findClosestBlockAtY(rootEl: HTMLElement, y: number): { blockEl: HTMLElement; position: 'before' | 'after' } | null {
  const blocks = rootEl.querySelectorAll<HTMLElement>(':scope > .node-block[data-block-id]');
  if (blocks.length === 0) return null;

  // Check all top-level blocks (they may be nested in the DOM but are direct children of the editor root)
  const allBlocks = rootEl.querySelectorAll<HTMLElement>('.node-block[data-block-id]');
  if (allBlocks.length === 0) return null;

  // If above all blocks, target first block 'before'
  const firstRect = allBlocks[0].getBoundingClientRect();
  if (y < firstRect.top) {
    return { blockEl: allBlocks[0], position: 'before' };
  }

  // If below all blocks, target last block 'after'
  const lastBlock = allBlocks[allBlocks.length - 1];
  const lastRect = lastBlock.getBoundingClientRect();
  if (y > lastRect.bottom) {
    return { blockEl: lastBlock, position: 'after' };
  }

  // Find the block the cursor is over
  for (let i = 0; i < allBlocks.length; i++) {
    const rect = allBlocks[i].getBoundingClientRect();
    if (y >= rect.top && y <= rect.bottom) {
      const relativeY = (y - rect.top) / rect.height;
      return { blockEl: allBlocks[i], position: relativeY < 0.5 ? 'before' : 'after' };
    }
  }

  // Between blocks — find the nearest gap
  let closestBlock = allBlocks[0];
  let closestDist = Infinity;
  for (let i = 0; i < allBlocks.length; i++) {
    const rect = allBlocks[i].getBoundingClientRect();
    const centerY = rect.top + rect.height / 2;
    const dist = Math.abs(y - centerY);
    if (dist < closestDist) {
      closestDist = dist;
      closestBlock = allBlocks[i];
    }
  }
  const rect = closestBlock.getBoundingClientRect();
  return { blockEl: closestBlock, position: y < rect.top + rect.height / 2 ? 'before' : 'after' };
}

export function DragDropPlugin({ editorId, readOnly }: DragDropPluginProps): null {
  const [editor] = useLexicalComposerContext();
  const dropIndicatorRef = useRef<HTMLDivElement | null>(null);

  // Mouse drag state
  const dragStateRef = useRef<{
    active: boolean;          // True once threshold exceeded
    pending: boolean;         // Mousedown happened, waiting for threshold
    startX: number;
    startY: number;
    blockId: string;
    blockEl: HTMLElement;
    sourceDepth: number;
  } | null>(null);

  // ─── Create/destroy drop indicator ─────────────────────────

  useEffect(() => {
    const indicator = document.createElement('div');
    indicator.className = 'node-block-drop-indicator';
    indicator.style.display = 'none';
    document.body.appendChild(indicator);
    dropIndicatorRef.current = indicator;

    return () => {
      indicator.remove();
    };
  }, []);

  // ─── Suppress native drag on bullets ───────────────────────

  useEffect(() => {
    if (readOnly) return;
    const rootEl = editor.getRootElement();
    if (!rootEl) return;

    // Prevent the native drag from starting — we handle it with mouse events
    const suppressNativeDrag = (e: Event) => {
      const target = (e as DragEvent).target as HTMLElement;
      if (target.closest('.bullet-wrapper')) {
        e.preventDefault();
      }
    };

    rootEl.addEventListener('dragstart', suppressNativeDrag, true);
    return () => {
      rootEl.removeEventListener('dragstart', suppressNativeDrag, true);
    };
  }, [editor, readOnly]);

  // ─── Mouse-based drag system ───────────────────────────────

  useEffect(() => {
    if (readOnly) return;
    const rootEl = editor.getRootElement();
    if (!rootEl) return;

    const handleMouseDown = (e: MouseEvent) => {
      // Only start drag from bullet wrappers, left button only
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      const bullet = target.closest('.bullet-wrapper') as HTMLElement | null;
      if (!bullet) return;

      // Don't drag if clicking collapse arrow
      if (target.closest('.bullet-collapse-arrow')) return;

      const blockEl = findBlockRow(bullet);
      if (!blockEl) return;

      const blockId = blockEl.getAttribute('data-block-id');
      if (!blockId) return;

      // Prevent focus/selection changes
      e.preventDefault();
      e.stopPropagation();

      const depth = parseInt(blockEl.getAttribute('data-depth') || '0', 10);

      dragStateRef.current = {
        active: false,
        pending: true,
        startX: e.clientX,
        startY: e.clientY,
        blockId,
        blockEl,
        sourceDepth: depth,
      };
    };

    const handleMouseMove = (e: MouseEvent) => {
      const state = dragStateRef.current;
      if (!state || (!state.pending && !state.active)) return;

      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Activate drag after threshold
      if (state.pending && dist >= DRAG_THRESHOLD) {
        state.pending = false;
        state.active = true;

        // Clear text selection
        window.getSelection()?.removeAllRanges();

        // Start coordinator
        const coordinator = getDragCoordinator();
        coordinator.startDrag({
          blockId: state.blockId,
          sourceEditorId: editorId,
          sourceDepth: state.sourceDepth,
        });

        // Visual feedback
        state.blockEl.classList.add('node-block--drag-source');
        document.body.classList.add('notees-dragging-block');
      }

      if (!state.active) return;

      // Find drop target — search ALL editors on the page, not just this one
      const target = e.target as HTMLElement;
      const blockEl = findBlockRow(target);
      const coordinator = getDragCoordinator();

      if (blockEl) {
        const blockId = blockEl.getAttribute('data-block-id');
        if (blockId && blockId !== state.blockId) {
          const rect = blockEl.getBoundingClientRect();
          const relativeY = (e.clientY - rect.top) / rect.height;
          const position: DropTarget['position'] = relativeY < 0.5 ? 'before' : 'after';

          // Determine which editor this block belongs to
          const targetEditorRoot = blockEl.closest('[data-editor-id]');
          const targetEditorId = targetEditorRoot?.getAttribute('data-editor-id') || editorId;

          coordinator.updateTarget({ blockId, position, targetEditorId });
          showDropIndicator(blockEl, position);
          return;
        } else if (blockId === state.blockId) {
          // Hovering over self — hide indicator
          coordinator.updateTarget(null);
          hideDropIndicator();
          return;
        }
      }

      // Not over a block — check if we're in an editor's empty space
      // Find the editor root we might be hovering over
      const editorContent = target.closest('.notees-editor-content') as HTMLElement | null;
      if (editorContent) {
        const result = findClosestBlockAtY(editorContent, e.clientY);
        if (result) {
          const closestId = result.blockEl.getAttribute('data-block-id');
          if (closestId && closestId !== state.blockId) {
            const targetEditorRoot = result.blockEl.closest('[data-editor-id]');
            const targetEditorId = targetEditorRoot?.getAttribute('data-editor-id') || editorId;
            coordinator.updateTarget({ blockId: closestId, position: result.position, targetEditorId });
            showDropIndicator(result.blockEl, result.position);
            return;
          }
        }
      }

      // Also check main scrollable area
      const mainContent = target.closest('.main-content') as HTMLElement | null;
      if (mainContent) {
        const editorRoot = mainContent.querySelector('.notees-editor-content') as HTMLElement | null;
        if (editorRoot) {
          const result = findClosestBlockAtY(editorRoot, e.clientY);
          if (result) {
            const closestId = result.blockEl.getAttribute('data-block-id');
            if (closestId && closestId !== state.blockId) {
              coordinator.updateTarget({ blockId: closestId, position: result.position, targetEditorId: editorId });
              showDropIndicator(result.blockEl, result.position);
              return;
            }
          }
        }
      }

      coordinator.updateTarget(null);
      hideDropIndicator();
    };

    const handleMouseUp = (_e: MouseEvent) => {
      const state = dragStateRef.current;
      if (!state) return;

      if (state.active) {
        const coordinator = getDragCoordinator();
        coordinator.completeDrag();
        hideDropIndicator();

        // Clean up visual state
        state.blockEl.classList.remove('node-block--drag-source');
        document.body.classList.remove('notees-dragging-block');
      }

      dragStateRef.current = null;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const state = dragStateRef.current;
        if (!state) return;
        if (state.active) {
          const coordinator = getDragCoordinator();
          coordinator.cancelDrag();
          hideDropIndicator();
          state.blockEl.classList.remove('node-block--drag-source');
          document.body.classList.remove('notees-dragging-block');
        }
        dragStateRef.current = null;
      }
    };

    // Use capture on rootEl for mousedown to catch bullet clicks before Lexical
    rootEl.addEventListener('mousedown', handleMouseDown, true);
    // Use document-level for move/up so the drag works across editor boundaries
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      rootEl.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [editor, editorId, readOnly]);

  // ─── Drop indicator ───────────────────────────────────────

  const showDropIndicator = useCallback((blockEl: HTMLElement, position: DropTarget['position']) => {
    const indicator = dropIndicatorRef.current;
    if (!indicator) return;

    const rect = blockEl.getBoundingClientRect();
    indicator.className = 'node-block-drop-indicator node-block-drop-indicator--line';

    const depth = parseInt(blockEl.getAttribute('data-depth') || '0', 10);
    const indentPx = depth * 24;

    indicator.style.display = 'block';
    indicator.style.left = `${rect.left + indentPx}px`;
    indicator.style.width = `${rect.width - indentPx}px`;
    indicator.style.height = '2px';
    indicator.style.top = position === 'before'
      ? `${rect.top - 1}px`
      : `${rect.bottom - 1}px`;
  }, []);

  const hideDropIndicator = useCallback(() => {
    const indicator = dropIndicatorRef.current;
    if (indicator) {
      indicator.style.display = 'none';
    }
  }, []);

  return null;
}
