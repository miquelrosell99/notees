/**
 * AutoWrapPlugin — Wraps selected text with matching pairs and auto-closes brackets.
 *
 * When text is selected and user types an opening character ([, (, {, ", '),
 * the plugin wraps the selection with the matching pair and keeps the selection
 * active so typing the same character again will wrap it again (e.g., [[ or (().
 *
 * When no text is selected, automatically inserts the closing character and
 * positions cursor between the pair.
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  COMMAND_PRIORITY_HIGH,
  KEY_DOWN_COMMAND,
  $getSelection,
  $isRangeSelection,
  $createTextNode,
} from 'lexical';

// Map of opening characters to their closing pairs
const WRAP_PAIRS: Record<string, string> = {
  '[': ']',
  '(': ')',
  '{': '}',
  '"': '"',
  "'": "'",
};

export function AutoWrapPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        const { key } = event;

        // Only handle our wrap characters
        if (!(key in WRAP_PAIRS)) return false;

        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return false;

        // Prevent default character insertion
        event.preventDefault();

        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;

          // Get the closing character
          const closer = WRAP_PAIRS[key];

          if (selection.isCollapsed()) {
            // No text selected: auto-close by inserting both characters
            // and positioning cursor between them
            const pairedText = `${key}${closer}`;
            const newNode = $createTextNode(pairedText);
            
            selection.insertNodes([newNode]);
            
            // Position cursor between the pair
            const newSelection = $getSelection();
            if ($isRangeSelection(newSelection)) {
              newNode.select(1, 1);
            }
          } else {
            // Text selected: wrap it and keep selection active on inner content
            const selectedText = selection.getTextContent();
            const wrappedText = `${key}${selectedText}${closer}`;
            const newNode = $createTextNode(wrappedText);
            
            // Insert the wrapped text
            selection.insertNodes([newNode]);

            // Re-select the inner content (between the wrapper characters)
            // This allows user to type the same character again to wrap further
            const newSelection = $getSelection();
            if ($isRangeSelection(newSelection)) {
              // Position cursor to select the content between the wrappers
              newNode.select(1, wrappedText.length - 1);
            }
          }
        });

        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  return null;
}
