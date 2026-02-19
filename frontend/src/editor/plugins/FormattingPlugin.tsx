/**
 * FormattingPlugin — Handles inline text formatting shortcuts.
 *
 * Ctrl+B: bold, Ctrl+I: italic, Ctrl+U: underline, Ctrl+E: inline code.
 * Backtick with selection applies code format.
 * Right-arrow at end of inline code exits the code span.
 * Paste with backtick patterns auto-converts to inline code nodes.
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $createTextNode,
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

  useEffect(() => {
    // ── Paste handler: convert `backtick` patterns to inline code ──
    const handlePaste = (event: ClipboardEvent) => {
      const plain = event.clipboardData?.getData('text/plain') ?? '';
      // Only intercept single-line pastes that contain backtick code patterns
      if (!plain.includes('`') || plain.includes('\n')) return;
      const segments = splitByBackticks(plain);
      if (!segments.some(s => s.isCode)) return;

      event.preventDefault();
      editor.update(() => {
        const sel = $getSelection();
        if (!$isRangeSelection(sel)) return;
        // Delete selected content first
        if (!sel.isCollapsed()) sel.deleteCharacter(false);

        const nodes = segments.map(seg => {
          const node = $createTextNode(seg.text);
          if (seg.isCode) node.setFormat(IS_CODE);
          return node;
        });
        sel.insertNodes(nodes);
      });
    };

    // ── Keydown handler ──────────────────────────────────────────
    const handleKeyDown = (event: KeyboardEvent) => {
      // Right-arrow at end of a styled node (mid-block) → reuse/insert plain sibling
      // (Block-edge style-exit is handled in BlockPlugin's KEY_ARROW_RIGHT_COMMAND.)
      if (event.key === 'ArrowRight' && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        let shouldHandle = false;
        editor.getEditorState().read(() => {
          const sel = $getSelection();
          if (!$isRangeSelection(sel) || !sel.isCollapsed()) return;
          const anchor = sel.anchor;
          const node = anchor.getNode();
          if (!$isTextNode(node)) return;
          const fmt = node.getFormat();
          if (fmt === 0) return;
          if (anchor.offset !== node.getTextContentSize()) return;
          // Only handle mid-block (last-descendant case is handled by BlockPlugin)
          const next = node.getNextSibling();
          if (next && $isTextNode(next) && next.getFormat() === 0) shouldHandle = true;
        });
        if (shouldHandle) {
          event.preventDefault();
          editor.update(() => {
            const sel = $getSelection();
            if (!$isRangeSelection(sel) || !sel.isCollapsed()) return;
            const node = sel.anchor.getNode();
            if (!$isTextNode(node)) return;
            const next = node.getNextSibling();
            if (next && $isTextNode(next) && next.getFormat() === 0) next.select(0, 0);
            const freshSel = $getSelection();
            if ($isRangeSelection(freshSel)) freshSel.format = 0;
          });
          return;
        }
      }

      // Left-arrow at start of a styled node (mid-block) → reuse/insert plain sibling
      if (event.key === 'ArrowLeft' && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        let shouldHandle = false;
        editor.getEditorState().read(() => {
          const sel = $getSelection();
          if (!$isRangeSelection(sel) || !sel.isCollapsed()) return;
          const anchor = sel.anchor;
          const node = anchor.getNode();
          if (!$isTextNode(node)) return;
          const fmt = node.getFormat();
          if (fmt === 0) return;
          if (anchor.offset !== 0) return;
          const prev = node.getPreviousSibling();
          if (prev && $isTextNode(prev) && prev.getFormat() === 0) shouldHandle = true;
        });
        if (shouldHandle) {
          event.preventDefault();
          editor.update(() => {
            const sel = $getSelection();
            if (!$isRangeSelection(sel) || !sel.isCollapsed()) return;
            const node = sel.anchor.getNode();
            if (!$isTextNode(node)) return;
            const prev = node.getPreviousSibling();
            if (prev && $isTextNode(prev) && prev.getFormat() === 0) prev.selectEnd();
            const freshSel = $getSelection();
            if ($isRangeSelection(freshSel)) freshSel.format = 0;
          });
          return;
        }
      }

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
        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          $trimSelectionWhitespace(selection);
          selection.formatText(fmt);
        });
      }
    };

    return editor.registerRootListener((rootElement, prevRootElement) => {
      prevRootElement?.removeEventListener('keydown', handleKeyDown);
      prevRootElement?.removeEventListener('paste', handlePaste as EventListener);
      rootElement?.addEventListener('keydown', handleKeyDown);
      rootElement?.addEventListener('paste', handlePaste as EventListener);
    });
  }, [editor]);

  return null;
}
