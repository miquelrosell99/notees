/**
 * CustomCaretPlugin — Fully replaces the native browser caret with a custom styled one.
 *
 * Features:
 * - **Normal mode**: Thin vertical line caret (2px wide, rounded corners)
 * - **Insert mode**: Block caret covering the character (press Insert key to toggle)
 * - Smooth animations and positioning
 * - Theme-aware styling with blink animation
 *
 * The native caret is hidden via CSS. This plugin renders a positioned div that
 * follows the cursor using Range.getBoundingClientRect().
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

export function CustomCaretPlugin({ readOnly = false }: { readOnly?: boolean }): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [overwriteMode, setOverwriteMode] = useState(false);
  const caretRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number>(0);

  // ─── Toggle Insert/Overwrite mode with Insert key ───────────

  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        if (event.key === 'Insert') {
          event.preventDefault();
          setOverwriteMode((prev) => !prev);
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, readOnly]);

  // ─── Overwrite behavior ──────────────────────────────────────
  // In overwrite mode, replace the character at cursor position.

  useEffect(() => {
    if (readOnly || !overwriteMode) return;

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
  }, [editor, readOnly, overwriteMode]);

  // ─── Skip format boundaries on arrow keys ───────────────────
  // Lexical places two cursor positions at text format boundaries
  // (e.g. between normal and bold text). This causes a double-press
  // to visually advance one character. We detect when the caret
  // didn't move visually and trigger an extra move.

  const lastVisualPosRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return false;
        if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false;

        // Capture the visual position before the move
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
        const beforeRect = sel.getRangeAt(0).getBoundingClientRect();
        lastVisualPosRef.current = { x: Math.round(beforeRect.left), y: Math.round(beforeRect.top) };

        return false; // Don't consume — let Lexical handle the move
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, readOnly]);

  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        const prev = lastVisualPosRef.current;
        if (!prev) return false;
        lastVisualPosRef.current = null;

        // Check if the visual position actually changed
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
        const afterRect = sel.getRangeAt(0).getBoundingClientRect();
        const dx = Math.abs(Math.round(afterRect.left) - prev.x);
        const dy = Math.abs(Math.round(afterRect.top) - prev.y);

        // If the cursor didn't visually move (same pixel position), we're at
        // a format boundary — read the Lexical selection and move once more
        if (dx < 1 && dy < 1) {
          editor.update(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;

            const anchor = selection.anchor;
            const node = anchor.getNode();

            // Determine direction from which edge we're at
            if ($isTextNode(node)) {
              if (anchor.offset === 0) {
                // At start of text node — we came from the left, try to move left into prev node
                const prev = node.getPreviousSibling();
                if (prev && $isTextNode(prev)) {
                  prev.select(prev.getTextContentSize(), prev.getTextContentSize());
                }
              } else if (anchor.offset === node.getTextContentSize()) {
                // At end of text node — we came from the right, try to move right into next node
                const next = node.getNextSibling();
                if (next && $isTextNode(next)) {
                  next.select(0, 0);
                }
              }
            }
          });
        }

        return false;
      },
      COMMAND_PRIORITY_CRITICAL,
    );
  }, [editor, readOnly]);

  // ─── Custom caret positioning ────────────────────────────────

  const updateCaretPosition = useCallback(() => {
    const caret = caretRef.current;
    if (!caret) return;

    const rootElement = editor.getRootElement();
    if (!rootElement) { 
      caret.style.display = 'none'; 
      return; 
    }

    // Check if the editor has focus
    const activeEl = document.activeElement;
    const editorHasFocus = rootElement.contains(activeEl) || rootElement === activeEl;
    if (!editorHasFocus) { 
      caret.style.display = 'none'; 
      return; 
    }

    const domSelection = window.getSelection();
    if (!domSelection || domSelection.rangeCount === 0 || !domSelection.isCollapsed) {
      caret.style.display = 'none';
      return;
    }

    const range = domSelection.getRangeAt(0);

    // Measure position and dimensions
    let rect: DOMRect;
    const { startContainer, startOffset } = range;

    if (overwriteMode) {
      // Block caret — measure the next character
      if (
        startContainer.nodeType === Node.TEXT_NODE &&
        startOffset < (startContainer.textContent?.length ?? 0)
      ) {
        const charRange = document.createRange();
        charRange.setStart(startContainer, startOffset);
        charRange.setEnd(startContainer, startOffset + 1);
        rect = charRange.getBoundingClientRect();

        // Fallback for zero-width characters
        if (rect.width < 1) {
          rect = range.getBoundingClientRect();
        }
      } else {
        rect = range.getBoundingClientRect();
      }
    } else {
      // Line caret — use collapsed range position
      rect = range.getBoundingClientRect();
    }

    // If rect has no height (edge case at format boundaries), don't hide caret
    // Use a minimum height to keep it visible
    if (rect.height < 1) {
      // Try to get a better rect from the parent element
      const parentEl = startContainer.nodeType === Node.TEXT_NODE 
        ? startContainer.parentElement 
        : startContainer as Element;
      if (parentEl) {
        const parentRect = parentEl.getBoundingClientRect();
        // Use parent's height and position, but keep the measured left position
        rect = new DOMRect(
          rect.left || parentRect.left,
          parentRect.top,
          rect.width || 2,
          parentRect.height || 20
        );
      } else {
        // Absolute fallback
        rect = new DOMRect(rect.left, rect.top, rect.width || 2, 20);
      }
    }

    // Position relative to editor root
    const editorRoot = rootElement.closest('.notees-editor');
    if (!editorRoot) { 
      caret.style.display = 'none'; 
      return; 
    }
    const editorRect = editorRoot.getBoundingClientRect();

    const top = rect.top - editorRect.top;
    const left = rect.left - editorRect.left;
    const height = rect.height > 1 ? rect.height : 20; // Minimum height fallback

    caret.style.display = 'block';
    caret.style.top = `${top}px`;
    caret.style.left = `${left}px`;
    caret.style.height = `${height}px`;

    if (overwriteMode) {
      // Block caret width covers the character
      const charWidth = rect.width > 1 ? rect.width : 8; // fallback for EOL
      caret.style.width = `${charWidth}px`;
      caret.classList.add('notees-custom-caret--block');
      caret.classList.remove('notees-custom-caret--line');
    } else {
      // Line caret is a thin vertical bar
      caret.style.width = '2px';
      caret.classList.add('notees-custom-caret--line');
      caret.classList.remove('notees-custom-caret--block');
    }
  }, [editor, overwriteMode]);

  // ─── Listen for selection changes ────────────────────────────

  useEffect(() => {
    const unregisterSelection = editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(updateCaretPosition);
        return false; // Don't consume
      },
      COMMAND_PRIORITY_HIGH,
    );

    const unregisterUpdate = editor.registerUpdateListener(() => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(updateCaretPosition);
    });

    // Initial position
    requestAnimationFrame(updateCaretPosition);

    return () => {
      unregisterSelection();
      unregisterUpdate();
      cancelAnimationFrame(rafRef.current);
    };
  }, [editor, updateCaretPosition]);

  // ─── Listen for focus/blur events ────────────────────────────

  useEffect(() => {
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
  }, [editor, updateCaretPosition]);

  // ─── Listen for DOM mutations (indent/outdent, style changes) ───

  useEffect(() => {
    const rootElement = editor.getRootElement();
    if (!rootElement) return;

    // Watch for attribute changes (data-depth, style, class changes on blocks)
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(updateCaretPosition);
    });

    observer.observe(rootElement, {
      attributes: true,
      attributeFilter: ['style', 'class', 'data-depth'],
      subtree: true,
    });

    return () => observer.disconnect();
  }, [editor, updateCaretPosition]);

  // ─── Listen for CSS transitions completing ───────────────────

  useEffect(() => {
    const rootElement = editor.getRootElement();
    if (!rootElement) return;

    const onTransitionEnd = (e: TransitionEvent) => {
      // Only respond to margin-left transitions (indent/outdent)
      if (e.propertyName === 'margin-left') {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(updateCaretPosition);
      }
    };

    rootElement.addEventListener('transitionend', onTransitionEnd, true);

    return () => {
      rootElement.removeEventListener('transitionend', onTransitionEnd, true);
    };
  }, [editor, updateCaretPosition]);

  // ─── Render ──────────────────────────────────────────────────

  if (readOnly) return null;

  return (
    <div
      ref={caretRef}
      className="notees-custom-caret"
      aria-hidden="true"
    />
  );
}
