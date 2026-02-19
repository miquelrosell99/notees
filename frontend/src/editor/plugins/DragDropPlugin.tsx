/**
 * DragDropPlugin — Lexical plugin for drag & drop via DragCoordinator.
 *
 * Lexical editors never move nodes themselves. They emit drag intents
 * to the DragCoordinator, which delegates to NodeGraphRuntime.
 */

import { useEffect, useCallback, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  COMMAND_PRIORITY_CRITICAL,
  DRAGSTART_COMMAND,
  DRAGOVER_COMMAND,
  DROP_COMMAND,
  DRAGEND_COMMAND,
} from 'lexical';
import { getDragCoordinator } from '../../runtime/DragCoordinator';
import type { DropTarget } from '../../runtime/types';

export interface DragDropPluginProps {
  editorId: string;
  readOnly?: boolean;
}

/**
 * Given any element inside a block, find the closest `.node-block[data-block-id]` row.
 * This avoids matching the small `.bullet-wrapper[data-block-id]` element.
 */
function findBlockRow(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null;
  return el.closest('.node-block[data-block-id]') as HTMLElement | null;
}

export function DragDropPlugin({ editorId, readOnly }: DragDropPluginProps): null {
  const [editor] = useLexicalComposerContext();
  const dropIndicatorRef = useRef<HTMLDivElement | null>(null);
  const isDraggingBlockRef = useRef(false);

  // ─── Create/destroy drop indicator ─────────────────────────

  useEffect(() => {
    const rootEl = editor.getRootElement();
    if (!rootEl) return;

    // Attach indicator to document body for fixed positioning
    const indicator = document.createElement('div');
    indicator.className = 'node-block-drop-indicator';
    indicator.style.display = 'none';
    document.body.appendChild(indicator);
    dropIndicatorRef.current = indicator;

    return () => {
      indicator.remove();
    };
  }, [editor]);

  // ─── Bridge native drag events to Lexical commands ────────

  useEffect(() => {
    if (readOnly) return;

    const rootEl = editor.getRootElement();
    if (!rootEl) return;

    // Listen for native dragstart events on bullet wrappers only
    const handleNativeDragStart = (event: Event) => {
      const dragEvent = event as DragEvent;
      const target = dragEvent.target as HTMLElement;

      // Only handle drags initiated from the bullet wrapper
      if (!target.closest('.bullet-wrapper[draggable="true"]')) return;

      // Prevent native text/element drag ghost + insertion
      dragEvent.stopPropagation();
      editor.dispatchCommand(DRAGSTART_COMMAND, dragEvent);
    };

    const handleNativeDragOver = (event: Event) => {
      if (!isDraggingBlockRef.current) return;
      const dragEvent = event as DragEvent;
      // Must preventDefault to allow drop
      dragEvent.preventDefault();
      dragEvent.stopPropagation();
      editor.dispatchCommand(DRAGOVER_COMMAND, dragEvent);
    };

    const handleNativeDrop = (event: Event) => {
      if (!isDraggingBlockRef.current) return;
      const dragEvent = event as DragEvent;
      // Prevent browser from inserting text/plain into contentEditable
      dragEvent.preventDefault();
      dragEvent.stopPropagation();
      editor.dispatchCommand(DROP_COMMAND, dragEvent);
    };

    const handleNativeDragEnd = (event: Event) => {
      if (!isDraggingBlockRef.current) return;
      const dragEvent = event as DragEvent;
      dragEvent.preventDefault();
      dragEvent.stopPropagation();
      editor.dispatchCommand(DRAGEND_COMMAND, dragEvent);
    };

    rootEl.addEventListener('dragstart', handleNativeDragStart, true);
    rootEl.addEventListener('dragover', handleNativeDragOver, true);
    rootEl.addEventListener('drop', handleNativeDrop, true);
    rootEl.addEventListener('dragend', handleNativeDragEnd, true);

    return () => {
      rootEl.removeEventListener('dragstart', handleNativeDragStart, true);
      rootEl.removeEventListener('dragover', handleNativeDragOver, true);
      rootEl.removeEventListener('drop', handleNativeDrop, true);
      rootEl.removeEventListener('dragend', handleNativeDragEnd, true);
    };
  }, [editor, readOnly]);

  // ─── Drag start ────────────────────────────────────────────

  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      DRAGSTART_COMMAND,
      (event: DragEvent) => {
        const target = event.target as HTMLElement;
        
        // Only initiate drag from bullet wrappers
        if (!target.closest('.bullet-wrapper[draggable="true"]')) return false;

        const blockEl = findBlockRow(target);
        if (!blockEl) return false;

        const blockId = blockEl.getAttribute('data-block-id');
        if (!blockId) return false;

        // Clear any text selection
        const selection = window.getSelection();
        if (selection) {
          selection.removeAllRanges();
        }

        isDraggingBlockRef.current = true;

        const depth = parseInt(blockEl.getAttribute('data-depth') || '0', 10);
        const coordinator = getDragCoordinator();
        coordinator.startDrag({ blockId, sourceEditorId: editorId, sourceDepth: depth });

        // Set drag data — use a custom MIME type to avoid text insertion
        if (event.dataTransfer) {
          event.dataTransfer.setData('application/x-notees-block', JSON.stringify({ blockId }));
          event.dataTransfer.effectAllowed = 'move';
          
          // Create a minimal drag ghost
          const ghost = document.createElement('div');
          ghost.style.cssText = 'position:fixed;top:-1000px;left:-1000px;padding:4px 12px;background:var(--color-surface-container);border:1px solid var(--color-outline-variant);border-radius:4px;font-size:12px;opacity:0.9;pointer-events:none;';
          ghost.textContent = 'Moving block…';
          document.body.appendChild(ghost);
          event.dataTransfer.setDragImage(ghost, 0, 0);
          requestAnimationFrame(() => ghost.remove());
        }

        // Add dragging class to source block and editor root
        blockEl.classList.add('node-block--drag-source');
        const editorWrapper = editor.getRootElement()?.closest('.notees-editor');
        if (editorWrapper) editorWrapper.classList.add('notees-editor--dragging');

        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );
  }, [editor, editorId, readOnly]);

  // ─── Drag over ─────────────────────────────────────────────

  useEffect(() => {
    return editor.registerCommand(
      DRAGOVER_COMMAND,
      (event: DragEvent) => {
        const coordinator = getDragCoordinator();
        if (!coordinator.isDragging()) return false;

        const target = event.target as HTMLElement;
        const blockEl = findBlockRow(target);
        if (!blockEl) {
          coordinator.updateTarget(null);
          hideDropIndicator();
          return true;
        }

        const blockId = blockEl.getAttribute('data-block-id');
        if (!blockId) return true;

        // Don't allow dropping on self
        const payload = coordinator.getDragPayload();
        if (payload && payload.blockId === blockId) {
          coordinator.updateTarget(null);
          hideDropIndicator();
          return true;
        }

        // Determine drop position based on mouse Y within the block content row
        const rect = blockEl.getBoundingClientRect();
        const y = event.clientY;
        const relativeY = (y - rect.top) / rect.height;

        // Simple top/bottom split — no child nesting zone
        const position: DropTarget['position'] = relativeY < 0.5 ? 'before' : 'after';

        coordinator.updateTarget({ blockId, position, targetEditorId: editorId });
        showDropIndicator(blockEl, position);

        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );
  }, [editor, editorId]);

  // ─── Drop ──────────────────────────────────────────────────

  useEffect(() => {
    return editor.registerCommand(
      DROP_COMMAND,
      (event: DragEvent) => {
        event.preventDefault();
        event.stopImmediatePropagation();

        const coordinator = getDragCoordinator();
        if (!coordinator.isDragging()) return false;

        coordinator.completeDrag();
        hideDropIndicator();
        cleanupDragSource();
        isDraggingBlockRef.current = false;
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );
  }, [editor]);

  // ─── Drag end ──────────────────────────────────────────────

  useEffect(() => {
    return editor.registerCommand(
      DRAGEND_COMMAND,
      () => {
        const coordinator = getDragCoordinator();
        coordinator.cancelDrag();
        hideDropIndicator();
        cleanupDragSource();
        isDraggingBlockRef.current = false;
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );
  }, [editor]);

  // ─── Drop indicator ───────────────────────────────────────

  const showDropIndicator = useCallback((blockEl: HTMLElement, position: DropTarget['position']) => {
    const indicator = dropIndicatorRef.current;
    if (!indicator) return;

    const rect = blockEl.getBoundingClientRect();
    // Reset styles
    indicator.style.background = '';
    indicator.className = 'node-block-drop-indicator';

    // Account for block depth indent for the left edge
    const depth = parseInt(blockEl.getAttribute('data-depth') || '0', 10);
    const indentPx = depth * 24; // Approximate indent per level

    indicator.style.display = 'block';
    indicator.style.left = `${rect.left + indentPx}px`;
    indicator.style.width = `${rect.width - indentPx}px`;
    indicator.style.height = '2px';
    indicator.classList.add('node-block-drop-indicator--line');

    if (position === 'before') {
      indicator.style.top = `${rect.top - 1}px`;
    } else {
      indicator.style.top = `${rect.bottom - 1}px`;
    }
  }, []);

  const hideDropIndicator = useCallback(() => {
    const indicator = dropIndicatorRef.current;
    if (indicator) {
      indicator.style.display = 'none';
    }
  }, []);

  // Clean up drag source styling
  const cleanupDragSource = useCallback(() => {
    const rootEl = editor.getRootElement();
    if (!rootEl) return;
    rootEl.querySelectorAll('.node-block--drag-source').forEach(el => {
      el.classList.remove('node-block--drag-source');
    });
    const editorWrapper = rootEl.closest('.notees-editor');
    if (editorWrapper) editorWrapper.classList.remove('notees-editor--dragging');
  }, [editor]);

  return null;
}
