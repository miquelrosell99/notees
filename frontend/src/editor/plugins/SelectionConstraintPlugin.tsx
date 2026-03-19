/**
 * SelectionConstraintPlugin — Constrains text selection to the active editing block.
 *
 * When Lexical's RangeSelection spans multiple blocks, this plugin clamps
 * it back to the block where the anchor lives (the "editing" block).
 * This ensures:
 * - Text selection via mouse drag never crosses block boundaries
 * - Copy/cut only captures content from the active block
 * - The custom caret overlay always renders within one block
 *
 * Works in concert with:
 * - CustomCaretPlugin (renders the selection highlight overlay)
 * - BlockDragSelectionPlugin (takes over when drag exits block bounds)
 */

import { useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  COPY_COMMAND,
  CUT_COMMAND,
  $getRoot,
  SELECTION_CHANGE_COMMAND,
} from 'lexical';
import { $isBlockNode, type BlockNode } from '../nodes/BlockNode';
import { findParentNodeBlock } from '../utils/selectionUtils';

export function SelectionConstraintPlugin({ readOnly = false }: { readOnly?: boolean }): null {
  const [editor] = useLexicalComposerContext();

  // ─── Clamp selection to anchor block ──────────────────────────
  // Use SELECTION_CHANGE_COMMAND to only fire on selection changes,
  // not on every Lexical update (typing, formatting, etc.).

  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || selection.isCollapsed()) return false;

        const anchorBlock = findParentNodeBlock(selection.anchor.getNode());
        const focusBlock = findParentNodeBlock(selection.focus.getNode());

        if (!anchorBlock || !focusBlock || anchorBlock === focusBlock) return false;

        // Schedule clamping in a write context
        editor.update(() => {
          const sel = $getSelection();
          if (!$isRangeSelection(sel) || sel.isCollapsed()) return;

          const anchor = findParentNodeBlock(sel.anchor.getNode());
          const focus = findParentNodeBlock(sel.focus.getNode());
          if (!anchor || !focus || anchor === focus) return;

          clampSelectionToBlock(sel, anchor);
        }, { tag: 'selection-constraint' });

        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, readOnly]);

  // ─── Custom copy: plain text from Lexical selection ───────────

  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      COPY_COMMAND,
      (event: ClipboardEvent) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || selection.isCollapsed()) return false;

        const text = selection.getTextContent();
        if (!text) return false;

        event.preventDefault();
        event.clipboardData?.setData('text/plain', text);

        // Also set HTML with inline formatting preserved
        const html = getSelectionHtml(selection);
        if (html) {
          event.clipboardData?.setData('text/html', html);
        }

        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, readOnly]);

  // ─── Custom cut: copy + delete selection ──────────────────────

  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      CUT_COMMAND,
      (event: ClipboardEvent) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || selection.isCollapsed()) return false;

        const text = selection.getTextContent();
        if (!text) return false;

        event.preventDefault();
        event.clipboardData?.setData('text/plain', text);

        const html = getSelectionHtml(selection);
        if (html) {
          event.clipboardData?.setData('text/html', html);
        }

        // Delete the selected content
        selection.removeText();

        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, readOnly]);

  // ─── Fix double-click / triple-click / Ctrl+A selection ─────────
  // Operates on the native DOM selection directly so the custom caret
  // overlay (which reads window.getSelection()) updates immediately.
  //
  // Double-click: intercept at mousedown to prevent the browser's
  // default word+trailing-space selection, then select just the word.
  // Triple-click / Ctrl+A: constrain selection to the block's
  // .node-block-content element.

  useEffect(() => {
    if (readOnly) return;

    const rootElement = editor.getRootElement();
    if (!rootElement) return;

    // Select all content within the active block's .node-block-content
    const selectBlockContent = (target: HTMLElement | null) => {
      const blockContent = target?.closest('.node-block-content');
      if (!blockContent) return;

      const range = document.createRange();
      range.selectNodeContents(blockContent);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    };

    // Intercept mousedown for double-click and triple-click
    const handleMouseDown = (e: MouseEvent) => {
      if (e.detail === 2) {
        // Double-click: prevent default word+space selection,
        // then select just the word under the cursor.
        e.preventDefault();

        const caretPos = document.caretRangeFromPoint?.(e.clientX, e.clientY)
                      ?? (document as any).caretPositionFromPoint?.(e.clientX, e.clientY);
        if (!caretPos) return;

        // caretRangeFromPoint returns a Range, caretPositionFromPoint returns { offsetNode, offset }
        const node = ('startContainer' in caretPos) ? caretPos.startContainer : caretPos.offsetNode;
        const offset = ('startOffset' in caretPos) ? caretPos.startOffset : caretPos.offset;

        if (node?.nodeType !== Node.TEXT_NODE) return;
        const text = node.textContent || '';

        // Find word boundaries (letters, numbers, unicode word chars)
        let wordStart = offset;
        let wordEnd = offset;

        // Expand left to find start of word
        while (wordStart > 0 && !/[\s\u200B]/.test(text[wordStart - 1])) {
          wordStart--;
        }
        // Expand right to find end of word (exclude trailing whitespace)
        while (wordEnd < text.length && !/[\s\u200B]/.test(text[wordEnd])) {
          wordEnd++;
        }

        if (wordStart === wordEnd) return;

        const range = document.createRange();
        range.setStart(node, wordStart);
        range.setEnd(node, wordEnd);
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } else if (e.detail >= 3) {
        // Triple-click: prevent browser paragraph selection, select block content
        e.preventDefault();
        selectBlockContent(e.target as HTMLElement);
      }
    };

    // Ctrl+A: select block content instead of entire editor
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const sel = window.getSelection();
        if (sel && sel.anchorNode) {
          const anchor = sel.anchorNode.nodeType === Node.TEXT_NODE
            ? sel.anchorNode.parentElement
            : sel.anchorNode as HTMLElement;
          selectBlockContent(anchor);
        }
      }
    };

    rootElement.addEventListener('mousedown', handleMouseDown);
    rootElement.addEventListener('keydown', handleKeyDown);
    return () => {
      rootElement.removeEventListener('mousedown', handleMouseDown);
      rootElement.removeEventListener('keydown', handleKeyDown);
    };
  }, [editor, readOnly]);

  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Clamp a RangeSelection so that the focus stays within the anchor's block.
 * If focus is in a later block, clamp to the end of the anchor block.
 * If focus is in an earlier block, clamp to the start of the anchor block.
 */
function clampSelectionToBlock(
  selection: ReturnType<typeof $getSelection> & { anchor: any; focus: any },
  anchorBlock: BlockNode,
): void {
  const root = $getRoot();
  const children = root.getChildren();

  // Determine if focus is before or after anchor block
  const anchorBlockIndex = children.indexOf(anchorBlock);
  const focusBlock = findParentNodeBlock(selection.focus.getNode());
  if (!focusBlock) return;
  const focusBlockIndex = children.indexOf(focusBlock);

  if (focusBlockIndex > anchorBlockIndex) {
    // Focus is below anchor — clamp to end of anchor block
    const lastChild = anchorBlock.getLastDescendant();
    if (lastChild) {
      const textLen = lastChild.getTextContentSize?.() ?? 0;
      selection.focus.set(lastChild.getKey(), textLen, lastChild.getType() === 'text' ? 'text' : 'element');
    }
  } else if (focusBlockIndex < anchorBlockIndex) {
    // Focus is above anchor — clamp to start of anchor block
    const firstChild = anchorBlock.getFirstDescendant();
    if (firstChild) {
      selection.focus.set(firstChild.getKey(), 0, firstChild.getType() === 'text' ? 'text' : 'element');
    }
  }
}

/**
 * Extract HTML representation of the current selection for rich paste.
 * Preserves inline formatting (bold, italic, etc.) via Lexical's text format.
 */
function getSelectionHtml(selection: any): string | null {
  try {
    const nodes = selection.getNodes();
    if (nodes.length === 0) return null;

    const parts: string[] = [];
    for (const node of nodes) {
      if ($isBlockNode(node)) continue; // Skip block wrappers

      const text = node.getTextContent();
      if (!text) continue;

      // Check Lexical text format flags
      const format = node.getFormat?.() ?? 0;
      let html = escapeHtml(text);

      if (format & 1) html = `<strong>${html}</strong>`;      // bold
      if (format & 2) html = `<em>${html}</em>`;              // italic
      if (format & 4) html = `<s>${html}</s>`;                // strikethrough
      if (format & 8) html = `<u>${html}</u>`;                // underline
      if (format & 16) html = `<code>${html}</code>`;         // code
      if (format & 32) html = `<sub>${html}</sub>`;           // subscript
      if (format & 64) html = `<sup>${html}</sup>`;           // superscript

      parts.push(html);
    }

    return parts.length > 0 ? parts.join('') : null;
  } catch {
    return null;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
