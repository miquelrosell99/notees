/**
 * EmptyClickPlugin — Prevents edit mode when clicking in empty space.
 * 
 * Handles:
 * - Clicks on the ContentEditable root (margins, space below blocks)
 * - Clicks directly on the .node-block container (rare, but possible)
 * 
 * The key issue: blocks have margin-left for indentation, creating empty
 * space in the editor. Clicks in that margin area should NOT enter edit mode.
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

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;

      // Only handle clicks that land inside the contenteditable area
      if (!rootElement.contains(target) && target !== rootElement) return;

      // Click on bullet → let bullet handler deal with it
      if (target.closest('.bullet-wrapper')) {
        return;
      }

      const nodeBlock = target.closest('.node-block') as HTMLElement | null;

      // Click on the ContentEditable root (margins, below blocks) → prevent edit mode
      if (target === rootElement) {
        event.preventDefault();
        event.stopPropagation();
        editor.blur();
        window.getSelection()?.removeAllRanges();
        return;
      }

      // Click on .node-block container itself (not on content) → prevent edit mode
      if (target === nodeBlock) {
        event.preventDefault();
        event.stopPropagation();
        editor.blur();
        window.getSelection()?.removeAllRanges();
        return;
      }

      // Click is on text/content elements → allow edit mode
    };

    container.addEventListener('mousedown', handleMouseDown, true);
    return () => {
      container.removeEventListener('mousedown', handleMouseDown, true);
    };
  }, [editor]);

  return null;
}
