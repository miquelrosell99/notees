/**
 * FormattingPlugin — Handles inline text formatting shortcuts.
 *
 * Ctrl+B: bold, Ctrl+I: italic, Ctrl+U: underline, etc.
 * Managed through Lexical's native formatting commands.
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  COMMAND_PRIORITY_HIGH,
  FORMAT_TEXT_COMMAND,
  KEY_MODIFIER_COMMAND,
  $getSelection,
  $isRangeSelection,
  type TextFormatType,
} from 'lexical';
import { $trimSelectionWhitespace } from '../utils/selectionUtils';

export function FormattingPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      KEY_MODIFIER_COMMAND,
      (event: KeyboardEvent) => {
        const { key, ctrlKey, metaKey, shiftKey } = event;
        if (!ctrlKey && !metaKey) return false;

        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return false;

        let format: TextFormatType | null = null;

        switch (key.toLowerCase()) {
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
            if (shiftKey) format = 'strikethrough';
            break;
        }

        if (format) {
          event.preventDefault();
          // Trim whitespace from selection before applying format
          editor.update(() => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              $trimSelectionWhitespace(selection);
            }
          });
          editor.dispatchCommand(FORMAT_TEXT_COMMAND, format);
          return true;
        }

        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  return null;
}
