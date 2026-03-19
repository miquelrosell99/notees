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
import { findParentNodeBlock, $trimSelectionWhitespace } from '../utils/selectionUtils';

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

  // ─── Trim trailing space on double-click word selection ────────
  // Browsers include the trailing space when double-clicking a word.
  // We trim it so only the word itself is selected.

  useEffect(() => {
    if (readOnly) return;

    const rootElement = editor.getRootElement();
    if (!rootElement) return;

    const handleDoubleClick = () => {
      editor.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection) && !selection.isCollapsed()) {
          $trimSelectionWhitespace(selection);
        }
      }, { tag: 'dblclick-trim' });
    };

    rootElement.addEventListener('dblclick', handleDoubleClick);
    return () => {
      rootElement.removeEventListener('dblclick', handleDoubleClick);
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
