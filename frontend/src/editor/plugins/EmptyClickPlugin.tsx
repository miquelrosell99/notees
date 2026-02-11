/**
 * EmptyClickPlugin — Handles clicks in empty space (gutters, margins, below blocks).
 * 
 * In list mode:
 * - Clicking below the last block should not create a cursor there
 * - Clicking on empty space to the left of blocks (margin area) should blur the editor
 * 
 * This plugin intercepts mousedown events and:
 * 1. Prevents default if the click is not on an actual block element
 * 2. Blurs the editor if clicking on empty space while in edit mode
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';

export interface EmptyClickPluginProps {
  /** Only active in list mode */
  mode?: 'list' | 'document';
}

export function EmptyClickPlugin({ mode = 'list' }: EmptyClickPluginProps): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    // Only apply in list mode
    if (mode !== 'list') return;

    const rootElement = editor.getRootElement();
    if (!rootElement) return;

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      
      // Check if the click is on a node-block or inside one
      const nodeBlock = target.closest('.node-block');
      
      // If clicking directly on the ContentEditable root or empty space (not on a block)
      if (target === rootElement || !nodeBlock) {
        // Prevent the default focus behavior
        event.preventDefault();
        event.stopPropagation();
        
        // If editor is focused, blur it to exit edit mode
        editor.blur();
        window.getSelection()?.removeAllRanges();
        return;
      }
    };

    // Use capture phase to intercept before Lexical processes
    rootElement.addEventListener('mousedown', handleMouseDown, true);

    return () => {
      rootElement.removeEventListener('mousedown', handleMouseDown, true);
    };
  }, [editor, mode]);

  return null;
}
