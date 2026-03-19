/**
 * AutoWrapPlugin — Wraps selected text with matching pairs and auto-closes brackets.
 *
 * When text is selected and user types an opening character ([, (, {, ", '),
 * the plugin wraps the selection with the matching pair and keeps the selection
 * active so typing the same character again will wrap it again (e.g., (().
 *
 * When no text is selected, automatically inserts the closing character and
 * positions cursor between the pair.
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  COMMAND_PRIORITY_NORMAL,
  KEY_DOWN_COMMAND,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
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

        const closer = WRAP_PAIRS[key];

        if (selection.isCollapsed()) {
          // No text selected: auto-close by inserting both characters
          // and positioning cursor between them.
          // Use insertText() which goes through Lexical's normal pipeline.
          event.preventDefault();
          selection.insertRawText(key + closer);
          // Move cursor back between the pair
          const sel = $getSelection();
          if ($isRangeSelection(sel)) {
            const node = sel.anchor.getNode();
            if ($isTextNode(node)) {
              const offset = sel.anchor.offset;
              node.select(offset - 1, offset - 1);
            }
          }
          return true;
        } else {
          // Text selected: insert opener before selection, closer after.
          // This preserves formatting on the selected content.
          event.preventDefault();

          const anchor = selection.anchor;
          const focus = selection.focus;

          // Determine which point comes first
          const isBackward = selection.isBackward();
          const startKey = isBackward ? focus.key : anchor.key;
          const startOffset = isBackward ? focus.offset : anchor.offset;
          const endKey = isBackward ? anchor.key : focus.key;
          const endOffset = isBackward ? anchor.offset : focus.offset;

          // For the simple single-node case, insert wrapper chars directly
          const startNode = isBackward ? focus.getNode() : anchor.getNode();
          const endNode = isBackward ? anchor.getNode() : focus.getNode();

          if ($isTextNode(startNode) && $isTextNode(endNode) && startNode === endNode) {
            const text = startNode.getTextContent();
            const before = text.slice(0, startOffset);
            const selected = text.slice(startOffset, endOffset);
            const after = text.slice(endOffset);
            startNode.setTextContent(before + key + selected + closer + after);
            // Re-select the inner content (between the wrapper characters)
            startNode.select(startOffset + 1, endOffset + 1);
          } else {
            // Multi-node selection: insert chars at boundaries
            if ($isTextNode(startNode)) {
              const text = startNode.getTextContent();
              startNode.setTextContent(text.slice(0, startOffset) + key + text.slice(startOffset));
            }
            if ($isTextNode(endNode)) {
              const text = endNode.getTextContent();
              // +1 because we inserted a char in the start node (if same node, handled above)
              endNode.setTextContent(text.slice(0, endOffset) + closer + text.slice(endOffset));
            }
            // Re-select inner content
            const newSel = $getSelection();
            if ($isRangeSelection(newSel)) {
              if (isBackward) {
                newSel.focus.set(startKey, startOffset + 1, 'text');
                newSel.anchor.set(endKey, endOffset, 'text');
              } else {
                newSel.anchor.set(startKey, startOffset + 1, 'text');
                newSel.focus.set(endKey, endOffset, 'text');
              }
            }
          }

          return true;
        }
      },
      COMMAND_PRIORITY_NORMAL,
    );
  }, [editor]);

  return null;
}
