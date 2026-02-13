/**
 * InsertModePlugin — Toggles between Insert (line caret) and Overwrite (block caret) modes.
 *
 * Press the Insert key to toggle.  In overwrite mode:
 * - The native line caret is hidden via CSS (`caret-color: transparent`)
 * - A themed block caret overlay covers the character at the cursor position
 * - Typed characters replace the character under the cursor rather than pushing text
 *
 * The block caret is rendered as a portal div positioned via `Range.getBoundingClientRect()`.
 */

import { useEffect, useRef, useCallback, useState, type JSX } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_CRITICAL,
  KEY_DOWN_COMMAND,
  SELECTION_CHANGE_COMMAND,
  CONTROLLED_TEXT_INSERTION_COMMAND,
} from 'lexical';

// ─── Component ──────────────────────────────────────────────────

export function InsertModePlugin({ readOnly = false }: { readOnly?: boolean }): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [overwrite, setOverwrite] = useState(false);
  const caretRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number>(0);

  // ─── Toggle on Insert key ────────────────────────────────────

  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        if (event.key === 'Insert') {
          event.preventDefault();
          setOverwrite((prev) => !prev);
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, readOnly]);

  // ─── Overwrite behavior ──────────────────────────────────────
  // Intercept text insertion to delete the character after the cursor first.

  useEffect(() => {
    if (readOnly || !overwrite) return;

    return editor.registerCommand(
      CONTROLLED_TEXT_INSERTION_COMMAND,
      (payload) => {
        // Only handle single-character string insertions (typing)
        if (typeof payload !== 'string' || payload.length !== 1) return false;

        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;

          const anchor = selection.anchor;
          const node = anchor.getNode();

          if ($isTextNode(node)) {
            const offset = anchor.offset;
            const text = node.getTextContent();

            if (offset < text.length) {
              // Replace the character at cursor position
              const before = text.slice(0, offset);
              const after = text.slice(offset + 1);
              node.setTextContent(before + payload + after);
              // Move cursor after the inserted character
              node.select(offset + 1, offset + 1);
            } else {
              // At end of text — just append (normal insert behavior)
              node.setTextContent(text + payload);
              node.select(offset + 1, offset + 1);
            }
          }
        });

        return true; // Handled — prevent default insertion
      },
      COMMAND_PRIORITY_CRITICAL,
    );
  }, [editor, readOnly, overwrite]);

  // ─── Toggle CSS class on editor root ─────────────────────────

  useEffect(() => {
    const rootEl = editor.getRootElement()?.closest('.notees-editor');
    if (!rootEl) return;
    rootEl.classList.toggle('notees-editor--overwrite', overwrite);
    return () => { rootEl.classList.remove('notees-editor--overwrite'); };
  }, [editor, overwrite]);

  // ─── Block caret positioning ─────────────────────────────────

  const updateCaretPosition = useCallback(() => {
    const caret = caretRef.current;
    if (!caret || !overwrite) {
      if (caret) caret.style.display = 'none';
      return;
    }

    const rootElement = editor.getRootElement();
    if (!rootElement) { caret.style.display = 'none'; return; }

    // Check if the editor (or an ancestor) has focus
    const activeEl = document.activeElement;
    const editorHasFocus = rootElement.contains(activeEl) || rootElement === activeEl;
    if (!editorHasFocus) { caret.style.display = 'none'; return; }

    const domSelection = window.getSelection();
    if (!domSelection || domSelection.rangeCount === 0 || !domSelection.isCollapsed) {
      caret.style.display = 'none';
      return;
    }

    const range = domSelection.getRangeAt(0);

    // Measure the character at the cursor. If the cursor is inside a text
    // node and not at the very end, measure the next character's rect.
    // Otherwise fall back to the collapsed caret rect with a default width.
    let rect: DOMRect;
    const { startContainer, startOffset } = range;

    if (
      startContainer.nodeType === Node.TEXT_NODE &&
      startOffset < (startContainer.textContent?.length ?? 0)
    ) {
      // Create a range spanning the next character
      const charRange = document.createRange();
      charRange.setStart(startContainer, startOffset);
      charRange.setEnd(startContainer, startOffset + 1);
      rect = charRange.getBoundingClientRect();

      // If the char is a zero-width space the rect has zero width — use fallback
      if (rect.width < 1) {
        rect = range.getBoundingClientRect();
      }
    } else {
      rect = range.getBoundingClientRect();
    }

    // Position the caret div relative to the editor root
    const editorRoot = rootElement.closest('.notees-editor');
    if (!editorRoot) { caret.style.display = 'none'; return; }
    const editorRect = editorRoot.getBoundingClientRect();

    const charWidth = rect.width > 1 ? rect.width : 8; // fallback width for EOL
    const top = rect.top - editorRect.top;
    const left = rect.left - editorRect.left;

    caret.style.display = 'block';
    caret.style.top = `${top}px`;
    caret.style.left = `${left}px`;
    caret.style.width = `${charWidth}px`;
    caret.style.height = `${rect.height}px`;
  }, [editor, overwrite]);

  // Re-position on selection changes
  useEffect(() => {
    if (!overwrite) return;

    const unregister = editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        // Schedule position update for after DOM settles
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(updateCaretPosition);
        return false; // Don't consume
      },
      COMMAND_PRIORITY_HIGH,
    );

    // Also listen for Lexical updates (content changes move the cursor)
    const unregisterUpdate = editor.registerUpdateListener(() => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(updateCaretPosition);
    });

    // Initial position
    requestAnimationFrame(updateCaretPosition);

    return () => {
      unregister();
      unregisterUpdate();
      cancelAnimationFrame(rafRef.current);
    };
  }, [editor, overwrite, updateCaretPosition]);

  // Also listen for focus/blur to show/hide the caret
  useEffect(() => {
    if (!overwrite) return;

    const rootElement = editor.getRootElement();
    if (!rootElement) return;

    const onFocusBlur = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(updateCaretPosition);
    };

    rootElement.addEventListener('focus', onFocusBlur, true);
    rootElement.addEventListener('blur', onFocusBlur, true);

    return () => {
      rootElement.removeEventListener('focus', onFocusBlur, true);
      rootElement.removeEventListener('blur', onFocusBlur, true);
    };
  }, [editor, overwrite, updateCaretPosition]);

  // ─── Render ──────────────────────────────────────────────────

  if (readOnly) return null;

  return (
    <div
      ref={caretRef}
      className="notees-block-caret"
      style={{ display: overwrite ? undefined : 'none' }}
      aria-hidden="true"
    />
  );
}
