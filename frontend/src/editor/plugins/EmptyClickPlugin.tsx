/**
 * EmptyClickPlugin — Handles clicks in empty space (gutters, margins, below blocks).
 * 
 * Works in both list and document modes:
 * - Clicking below the last block should not create a cursor there
 * - Clicking on empty space to the left/right of text should blur the editor
 * - Clicking on the .node-block div itself (not on text content) should blur
 * 
 * Uses coordinate-based detection: compares the click position against the
 * actual text extent (measured via Range.getClientRects) to determine if the
 * click is on real text or on empty space within a stretched content element.
 *
 * Handler is registered on the .notees-editor wrapper in capture phase so
 * it fires BEFORE Lexical's own contenteditable handlers, allowing us to
 * preventDefault() before the browser places a caret.
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';

export interface EmptyClickPluginProps {
  mode?: 'list' | 'document';
}

export function EmptyClickPlugin({ mode: _mode = 'list' }: EmptyClickPluginProps): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const rootElement = editor.getRootElement();
    if (!rootElement) return;

    const container = (rootElement.closest('.notees-editor')
      || rootElement.closest('.node-card__children')
      || rootElement.parentElement) as HTMLElement | null;
    if (!container) return;

    const exitEditMode = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      editor.blur();
      window.getSelection()?.removeAllRanges();
      (editor as any).__clearBlockSelection?.();
    };

    /**
     * Measure the rightmost pixel of actual rendered text/inline content
     * inside an element, using Range.getClientRects().
     * Returns 0 if the element is empty (no text rects).
     */
    const getTextMaxRight = (el: Element): number => {
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        const rects = range.getClientRects();
        range.detach();
        let maxRight = 0;
        for (let i = 0; i < rects.length; i++) {
          if (rects[i].right > maxRight) maxRight = rects[i].right;
        }
        return maxRight;
      } catch {
        return 0;
      }
    };

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;

      // Only handle clicks that land inside the contenteditable area
      if (!rootElement.contains(target) && target !== rootElement) return;

      const nodeBlock = target.closest('.node-block') as HTMLElement | null;

      // Click on the ContentEditable root or outside any block → exit
      if (target === rootElement || !nodeBlock) {
        exitEditMode(event);
        return;
      }

      // Click on bullet → let bullet handler deal with it
      if (target.closest('.node-block-bullet')) {
        return;
      }

      // Click directly on the .node-block div (not on any child) → exit
      if (target === nodeBlock) {
        exitEditMode(event);
        return;
      }

      // Click is on a content element (p, span, etc.) inside the block.
      // The element might stretch wider than the actual text (flex, block layout).
      // Use Range to measure true text extent and compare with click position.

      // Walk up to find the direct child of .node-block that contains the click
      let contentEl: Element | null = target;
      while (contentEl && contentEl.parentElement !== nodeBlock) {
        contentEl = contentEl.parentElement;
      }
      // Safety: if we ended up at the bullet, let through
      if (!contentEl || contentEl.classList.contains('node-block-bullet')) return;

      const textMaxRight = getTextMaxRight(contentEl);

      // Empty block (no text rects) → allow click to enter edit mode
      if (textMaxRight === 0) return;

      // Click is beyond the text's rightmost pixel (+2px tolerance) → exit
      if (event.clientX > textMaxRight + 2) {
        exitEditMode(event);
        return;
      }

      // Click is on actual text content → let through to Lexical for editing
    };

    container.addEventListener('mousedown', handleMouseDown, true);
    return () => {
      container.removeEventListener('mousedown', handleMouseDown, true);
    };
  }, [editor]);

  return null;
}
