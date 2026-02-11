/**
 * DragDropPlugin — Lexical plugin for drag & drop via DragCoordinator.
 *
 * Lexical editors never move nodes themselves. They emit drag intents
 * to the DragCoordinator, which delegates to NodeGraphRuntime.
 */

import { useEffect, useCallback, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  COMMAND_PRIORITY_HIGH,
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

export function DragDropPlugin({ editorId, readOnly }: DragDropPluginProps): null {
  const [editor] = useLexicalComposerContext();
  const dropIndicatorRef = useRef<HTMLDivElement | null>(null);

  // ─── Create/destroy drop indicator ─────────────────────────

  useEffect(() => {
    const indicator = document.createElement('div');
    indicator.className = 'node-block-drop-indicator';
    indicator.style.display = 'none';
    indicator.style.position = 'absolute';
    indicator.style.height = '2px';
    indicator.style.background = 'var(--color-accent, #3b82f6)';
    indicator.style.pointerEvents = 'none';
    indicator.style.zIndex = '100';
    document.body.appendChild(indicator);
    dropIndicatorRef.current = indicator;

    return () => {
      indicator.remove();
    };
  }, []);

  // ─── Drag start ────────────────────────────────────────────

  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      DRAGSTART_COMMAND,
      (event: DragEvent) => {
        const target = event.target as HTMLElement;
        const blockEl = target.closest('[data-block-id]');
        if (!blockEl) return false;

        const blockId = blockEl.getAttribute('data-block-id');
        if (!blockId) return false;

        const depth = parseInt(blockEl.getAttribute('data-depth') || '0', 10);
        const coordinator = getDragCoordinator();
        coordinator.startDrag({ blockId, sourceEditorId: editorId, sourceDepth: depth });

        // Set drag data
        if (event.dataTransfer) {
          event.dataTransfer.setData('text/plain', blockId);
          event.dataTransfer.effectAllowed = 'move';
        }

        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, editorId, readOnly]);

  // ─── Drag over ─────────────────────────────────────────────

  useEffect(() => {
    return editor.registerCommand(
      DRAGOVER_COMMAND,
      (event: DragEvent) => {
        event.preventDefault();
        const coordinator = getDragCoordinator();
        if (!coordinator.isDragging()) return false;

        const target = event.target as HTMLElement;
        const blockEl = target.closest('[data-block-id]');
        if (!blockEl) {
          coordinator.updateTarget(null);
          hideDropIndicator();
          return true;
        }

        const blockId = blockEl.getAttribute('data-block-id');
        if (!blockId) return true;

        // Determine drop position based on mouse Y
        const rect = blockEl.getBoundingClientRect();
        const y = event.clientY;
        const relativeY = (y - rect.top) / rect.height;

        let position: DropTarget['position'];
        if (relativeY < 0.25) {
          position = 'before';
        } else if (relativeY > 0.75) {
          position = 'after';
        } else {
          position = 'child';
        }

        coordinator.updateTarget({ blockId, position, targetEditorId: editorId });
        showDropIndicator(blockEl as HTMLElement, position);

        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, editorId]);

  // ─── Drop ──────────────────────────────────────────────────

  useEffect(() => {
    return editor.registerCommand(
      DROP_COMMAND,
      (event: DragEvent) => {
        event.preventDefault();
        const coordinator = getDragCoordinator();
        coordinator.completeDrag();
        hideDropIndicator();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
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
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  // ─── Drop indicator ───────────────────────────────────────

  const showDropIndicator = useCallback((blockEl: HTMLElement, position: DropTarget['position']) => {
    const indicator = dropIndicatorRef.current;
    if (!indicator) return;

    const rect = blockEl.getBoundingClientRect();
    indicator.style.display = 'block';
    indicator.style.left = `${rect.left}px`;
    indicator.style.width = `${rect.width}px`;

    switch (position) {
      case 'before':
        indicator.style.top = `${rect.top - 1}px`;
        indicator.style.height = '2px';
        break;
      case 'after':
        indicator.style.top = `${rect.bottom - 1}px`;
        indicator.style.height = '2px';
        break;
      case 'child':
        indicator.style.top = `${rect.top}px`;
        indicator.style.height = `${rect.height}px`;
        indicator.style.background = 'var(--color-accent-light, rgba(59,130,246,0.1))';
        break;
    }
  }, []);

  const hideDropIndicator = useCallback(() => {
    const indicator = dropIndicatorRef.current;
    if (indicator) {
      indicator.style.display = 'none';
      indicator.style.background = 'var(--color-accent, #3b82f6)';
    }
  }, []);

  return null;
}
