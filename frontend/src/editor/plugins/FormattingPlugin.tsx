/**
 * FormattingPlugin — Handles inline text formatting shortcuts.
 *
 * Ctrl+B: bold, Ctrl+I: italic, Ctrl+U: underline, etc.
 * Uses a direct keydown listener to reliably intercept modifier keys.
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  type TextFormatType,
} from 'lexical';
import { $trimSelectionWhitespace } from '../utils/selectionUtils';

export function FormattingPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Backtick with selection → apply inline code format
      if (event.key === '`' && !event.ctrlKey && !event.metaKey) {
        let hasSelection = false;
        editor.getEditorState().read(() => {
          const sel = $getSelection();
          if ($isRangeSelection(sel) && !sel.isCollapsed()) hasSelection = true;
        });
        if (hasSelection) {
          event.preventDefault();
          editor.update(() => {
            const sel = $getSelection();
            if (!$isRangeSelection(sel)) return;
            $trimSelectionWhitespace(sel);
            sel.formatText('code');
          });
          return;
        }
      }

      if (!event.ctrlKey && !event.metaKey) return;

      let format: TextFormatType | null = null;

      switch (event.key.toLowerCase()) {
        case 'b':
          format = 'bold';
          break;
        case 'i':
          format = 'italic';
          break;
        case 'u':
          format = 'underline';
          break;
        case 'd':
          if (event.shiftKey) format = 'strikethrough';
          break;
        case 'e':
          format = 'code';
          break;
      }

      if (format) {
        event.preventDefault();
        const fmt = format;
        // Apply trim + format in a single synchronous update
        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          $trimSelectionWhitespace(selection);
          selection.formatText(fmt);
        });
      }
    };

    // Register on mount and re-register if root element changes
    return editor.registerRootListener((rootElement, prevRootElement) => {
      prevRootElement?.removeEventListener('keydown', handleKeyDown);
      rootElement?.addEventListener('keydown', handleKeyDown);
    });
  }, [editor]);

  return null;
}
