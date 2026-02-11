/**
 * EmptyClickPlugin — Prevents clicks in empty space below blocks from focusing the editor.
 * 
 * In list mode, clicking below the last block should not create a cursor there.
 * This plugin intercepts mousedown events and prevents default if the click
 * is not on an actual block element.
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
      
      // If clicking directly on the ContentEditable root (not on a block),
      // prevent the default focus behavior
      if (target === rootElement) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      
      // Check if the click is on a node-block or inside one
      const nodeBlock = target.closest('.node-block');
      if (!nodeBlock) {
        // Click is not on any block - prevent focus
        event.preventDefault();
        event.stopPropagation();
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
