/**
 * FormattingPlugin — Handles inline text formatting shortcuts.
 *
 * Ctrl+B: bold, Ctrl+I: italic, Ctrl+U: underline, Ctrl+E: inline code.
 * Backtick with selection applies code format.
 * Right-arrow at end of inline code exits the code span.
 * Paste with backtick patterns auto-converts to inline code nodes.
 *
 * Uses Lexical command system (not raw DOM listeners) so other plugins
 * can coordinate via the priority system.
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $createTextNode,
  COMMAND_PRIORITY_NORMAL,
  KEY_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  PASTE_COMMAND,
  type TextFormatType,
} from 'lexical';
import { $trimSelectionWhitespace } from '../utils/selectionUtils';

/** IS_CODE format bit in Lexical */
const IS_CODE = 16;

/** Split plain text by backtick patterns into segments */
function splitByBackticks(s: string): Array<{ text: string; isCode: boolean }> {
  const parts: Array<{ text: string; isCode: boolean }> = [];
  const re = /(`[^`\n]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) parts.push({ text: s.slice(last, m.index), isCode: false });
    parts.push({ text: m[0].slice(1, -1), isCode: true });
    last = re.lastIndex;
  }
  if (last < s.length) parts.push({ text: s.slice(last), isCode: false });
  return parts;
}

export function FormattingPlugin(): null {
  const [editor] = useLexicalComposerContext();

  // ── Arrow key: exit styled node at boundaries ──────────────

  useEffect(() => {
    // Right-arrow at end of a styled node (mid-block) → move to plain sibling
    // (Block-edge style-exit is handled in BlockPlugin's KEY_ARROW_RIGHT_COMMAND.)
    const handleArrowRight = (event: KeyboardEvent) => {
      if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false;

      const sel = $getSelection();
      if (!$isRangeSelection(sel) || !sel.isCollapsed()) return false;
      const anchor = sel.anchor;
      const node = anchor.getNode();
      if (!$isTextNode(node)) return false;
      if (node.getFormat() === 0) return false;
      if (anchor.offset !== node.getTextContentSize()) return false;
      const next = node.getNextSibling();
      if (!next || !$isTextNode(next) || next.getFormat() !== 0) return false;

      event.preventDefault();
      next.select(0, 0);
      const freshSel = $getSelection();
      if ($isRangeSelection(freshSel)) freshSel.format = 0;
      return true;
    };

    // Left-arrow at start of a styled node (mid-block) → move to plain sibling
    const handleArrowLeft = (event: KeyboardEvent) => {
      if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false;

      const sel = $getSelection();
      if (!$isRangeSelection(sel) || !sel.isCollapsed()) return false;
      const anchor = sel.anchor;
      const node = anchor.getNode();
      if (!$isTextNode(node)) return false;
      if (node.getFormat() === 0) return false;
      if (anchor.offset !== 0) return false;
      const prev = node.getPreviousSibling();
      if (!prev || !$isTextNode(prev) || prev.getFormat() !== 0) return false;

      event.preventDefault();
      prev.selectEnd();
      const freshSel = $getSelection();
      if ($isRangeSelection(freshSel)) freshSel.format = 0;
      return true;
    };

    const unsubRight = editor.registerCommand(KEY_ARROW_RIGHT_COMMAND, handleArrowRight, COMMAND_PRIORITY_NORMAL);
    const unsubLeft = editor.registerCommand(KEY_ARROW_LEFT_COMMAND, handleArrowLeft, COMMAND_PRIORITY_NORMAL);

    return () => {
      unsubRight();
      unsubLeft();
    };
  }, [editor]);

  // ── Format shortcuts and backtick wrapping ────────────────────

  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        // Backtick with selection → apply inline code format
        if (event.key === '`' && !event.ctrlKey && !event.metaKey) {
          const sel = $getSelection();
          if ($isRangeSelection(sel) && !sel.isCollapsed()) {
            event.preventDefault();
            $trimSelectionWhitespace(sel);
            sel.formatText('code');
            return true;
          }
          return false;
        }

        if (!event.ctrlKey && !event.metaKey) return false;

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
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return false;
          $trimSelectionWhitespace(selection);
          selection.formatText(format);
          return true;
        }

        return false;
      },
      COMMAND_PRIORITY_NORMAL,
    );
  }, [editor]);

  // ── Paste handler: convert `backtick` patterns to inline code ──

  useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event: ClipboardEvent) => {
        const plain = event.clipboardData?.getData('text/plain') ?? '';
        // Only intercept single-line pastes that contain backtick code patterns
        if (!plain.includes('`') || plain.includes('\n')) return false;
        const segments = splitByBackticks(plain);
        if (!segments.some(s => s.isCode)) return false;

        event.preventDefault();
        const sel = $getSelection();
        if (!$isRangeSelection(sel)) return false;
        if (!sel.isCollapsed()) sel.deleteCharacter(false);

        const nodes = segments.map(seg => {
          const node = $createTextNode(seg.text);
          if (seg.isCode) node.setFormat(IS_CODE);
          return node;
        });
        sel.insertNodes(nodes);
        return true;
      },
      COMMAND_PRIORITY_NORMAL,
    );
  }, [editor]);

  return null;
}
