/**
 * EmptyClickPlugin — Handles clicks in empty space (gutters, margins, below blocks).
 * 
 * Works in both list and document modes:
 * - Clicking below the last block should not create a cursor there
 * - Clicking on empty space to the left of blocks (margin area) should blur the editor
 * - Clicking on the .node-block div itself (not on content children) should blur
 * 
 * This plugin intercepts mousedown events and:
 * 1. Prevents default if the click is not on actual block content
 * 2. Blurs the editor if clicking on empty space while in edit mode
 * 3. Clears any block selection via the editor's __clearBlockSelection method
 *
 * IMPORTANT: The handler is registered on the .notees-editor wrapper (parent of
 * the ContentEditable), not on the ContentEditable root itself. This ensures our
 * capture-phase handler fires BEFORE Lexical's own contenteditable handlers,
 * so we can preventDefault() before the browser places a cursor.
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';

export interface EmptyClickPluginProps {
  /** Editor display mode (both modes are handled) */
  mode?: 'list' | 'document';
}

export function EmptyClickPlugin({ mode: _mode = 'list' }: EmptyClickPluginProps): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const rootElement = editor.getRootElement();
    if (!rootElement) return;

    // Register on a parent of the ContentEditable so our capture-phase
    // handler fires BEFORE any handler Lexical registers on rootElement.
    const container = (rootElement.closest('.notees-editor')
      || rootElement.closest('.node-card__children')
      || rootElement.parentElement) as HTMLElement | null;
    if (!container) return;

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;

      // Only handle clicks that land inside (or on) the contenteditable area
      if (!rootElement.contains(target) && target !== rootElement) return;

      // Check if the click is on a node-block or inside one
      const nodeBlock = target.closest('.node-block');
      
      // Case 1: Click on the ContentEditable root or empty space (not on a block)
      if (target === rootElement || !nodeBlock) {
        event.preventDefault();
        event.stopPropagation();
        editor.blur();
        window.getSelection()?.removeAllRanges();
        (editor as any).__clearBlockSelection?.();
        return;
      }

      // Case 2: Click on the .node-block div itself (empty space beyond text),
      // not on a content child like <p> or <span>
      if (target === nodeBlock) {
        event.preventDefault();
        event.stopPropagation();
        editor.blur();
        window.getSelection()?.removeAllRanges();
        (editor as any).__clearBlockSelection?.();
        return;
      }

      // Case 3: Click on the bullet area — let bullet's own handler deal with it
      if (target.closest('.node-block-bullet')) {
        return;
      }

      // Everything else (actual text content in <p>/<span>) → let through to Lexical
    };

    // Capture phase on ancestor → fires before contenteditable handlers
    container.addEventListener('mousedown', handleMouseDown, true);

    return () => {
      container.removeEventListener('mousedown', handleMouseDown, true);
    };
  }, [editor]);

  return null;
}
