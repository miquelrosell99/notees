/**
 * CustomCaretPlugin — Fully replaces the native browser caret with a custom one.
 *
 * Features:
 * - **Normal mode**: Thin vertical line caret (2px wide, rounded corners)
 * - **Insert mode**: Block caret covering the character (Insert key toggle)
 * - **Pill surround**: When navigating onto a node link, caret smoothly wraps it
 * - **Breathing blink**: Sine-eased opacity 1→0.15→1 with subtle width pulse
 * - **Idle fade**: After 4s of inactivity, caret fades to low opacity; restores on keypress
 * - Theme-aware styling via --color-caret token
 *
 * The native caret is hidden via CSS (`caret-color: transparent`).
 */

import { useEffect, useRef, useCallback, useState, type JSX } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  $isNodeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_CRITICAL,
  KEY_DOWN_COMMAND,
  SELECTION_CHANGE_COMMAND,
  CONTROLLED_TEXT_INSERTION_COMMAND,
} from 'lexical';
import { $isPillNode } from '../nodes/PillNode';

// Idle timeout (ms) before the caret starts to fade
const IDLE_TIMEOUT = 4000;

// ─── Component ──────────────────────────────────────────────────

export function CustomCaretPlugin({ readOnly = false }: { readOnly?: boolean }): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [overwriteMode, setOverwriteMode] = useState(false);
  const caretRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number>(0);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isIdleRef = useRef(false);
  // Track whether we've set an initial position (skip transition on first placement)
  const hasPositionedRef = useRef(false);

  // ─── Idle detection helpers ──────────────────────────────────

  const markActive = useCallback(() => {
    const caret = caretRef.current;
    if (!caret) return;

    if (isIdleRef.current) {
      isIdleRef.current = false;
      caret.classList.remove('notees-custom-caret--idle');
      caret.classList.add('notees-custom-caret--active');
      // Remove the --active class after the snap-in transition
      setTimeout(() => caret.classList.remove('notees-custom-caret--active'), 150);
    }

    // Reset idle timer
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      isIdleRef.current = true;
      if (caretRef.current) {
        caretRef.current.classList.add('notees-custom-caret--idle');
      }
    }, IDLE_TIMEOUT);
  }, []);

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

    // Get editor root for relative positioning
    const editorRoot = rootElement.closest('.notees-editor');
    if (!editorRoot) {
      caret.style.display = 'none';
      return;
    }
    const editorRect = editorRoot.getBoundingClientRect();

    // ─── Check if a pill node is selected (NodeSelection) ───
    let isPillSelected = false;
    editor.getEditorState().read(() => {
      const selection = $getSelection();
      if ($isNodeSelection(selection)) {
        const nodes = selection.getNodes();
        isPillSelected = nodes.length === 1 && $isPillNode(nodes[0]);
      }
    });

    if (isPillSelected) {
      // Find the selected pill DOM element
      const selectedPill = rootElement.querySelector('.node-pill-wrapper.selected, .node-pill-wrapper--selected');
      if (selectedPill) {
        const pillRect = selectedPill.getBoundingClientRect();
        const padding = 3;

        // Disable position transitions on first placement
        if (!hasPositionedRef.current) {
          caret.style.transition = 'none';
          hasPositionedRef.current = true;
          requestAnimationFrame(() => { caret.style.transition = ''; });
        }

        caret.style.display = 'block';
        caret.style.top = `${pillRect.top - editorRect.top - padding}px`;
        caret.style.left = `${pillRect.left - editorRect.left - padding}px`;
        caret.style.width = `${pillRect.width + padding * 2}px`;
        caret.style.height = `${pillRect.height + padding * 2}px`;

        // Apply pill mode classes
        caret.classList.remove('notees-custom-caret--line', 'notees-custom-caret--block');
        caret.classList.add('notees-custom-caret--pill');
        return;
      }
    }

    // ─── Non-pill: text caret positioning ───

    const domSelection = window.getSelection();
    if (!domSelection || domSelection.rangeCount === 0 || !domSelection.isCollapsed) {
      caret.style.display = 'none';
      return;
    }

    const range = domSelection.getRangeAt(0);
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

        if (rect.width < 1) {
          rect = range.getBoundingClientRect();
        }
      } else {
        rect = range.getBoundingClientRect();
      }
    } else {
      // Line caret — collapsed range
      rect = range.getBoundingClientRect();
    }

    // Height fallback for format boundaries
    if (rect.height < 1) {
      const parentEl = startContainer.nodeType === Node.TEXT_NODE
        ? startContainer.parentElement
        : startContainer as Element;
      if (parentEl) {
        const parentRect = parentEl.getBoundingClientRect();
        rect = new DOMRect(
          rect.left || parentRect.left,
          parentRect.top,
          rect.width || 2,
          parentRect.height || 20
        );
      } else {
        rect = new DOMRect(rect.left, rect.top, rect.width || 2, 20);
      }
    }

    const top = rect.top - editorRect.top;
    const left = rect.left - editorRect.left;
    const height = rect.height > 1 ? rect.height : 20;

    // Disable position transitions on first placement
    if (!hasPositionedRef.current) {
      caret.style.transition = 'none';
      hasPositionedRef.current = true;
      requestAnimationFrame(() => { caret.style.transition = ''; });
    }

    caret.style.display = 'block';
    caret.style.top = `${top}px`;
    caret.style.left = `${left}px`;
    caret.style.height = `${height}px`;

    // Remove pill class
    caret.classList.remove('notees-custom-caret--pill');

    if (overwriteMode) {
      const charWidth = rect.width > 1 ? rect.width : 8;
      caret.style.width = `${charWidth}px`;
      caret.classList.add('notees-custom-caret--block');
      caret.classList.remove('notees-custom-caret--line');
    } else {
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
        markActive();
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(updateCaretPosition);
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );

    const unregisterUpdate = editor.registerUpdateListener(() => {
      markActive();
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
  }, [editor, updateCaretPosition, markActive]);

  // ─── Mark active on any keypress ────────────────────────────

  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      () => {
        markActive();
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, readOnly, markActive]);

  // ─── Listen for focus/blur events ────────────────────────────

  useEffect(() => {
    const rootElement = editor.getRootElement();
    if (!rootElement) return;

    const onFocus = () => {
      markActive();
      hasPositionedRef.current = false; // Reset so first position after focus skips transition
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(updateCaretPosition);
    };

    const onBlur = () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(updateCaretPosition);
    };

    rootElement.addEventListener('focus', onFocus, true);
    rootElement.addEventListener('blur', onBlur, true);

    return () => {
      rootElement.removeEventListener('focus', onFocus, true);
      rootElement.removeEventListener('blur', onBlur, true);
    };
  }, [editor, updateCaretPosition, markActive]);

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

  // ─── Cleanup idle timer on unmount ───────────────────────────

  useEffect(() => {
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, []);

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
