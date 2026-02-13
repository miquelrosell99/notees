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
  // Track previous Y position for elastic bounce on block jumps
  const prevTopRef = useRef<number | null>(null);

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
  const lastArrowDirRef = useRef<'left' | 'right' | null>(null);

  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return false;
        if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false;

        // Capture visual position and direction before the move
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
        const beforeRect = sel.getRangeAt(0).getBoundingClientRect();
        lastVisualPosRef.current = { x: Math.round(beforeRect.left), y: Math.round(beforeRect.top) };
        lastArrowDirRef.current = event.key === 'ArrowLeft' ? 'left' : 'right';

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
        const dir = lastArrowDirRef.current;
        if (!prev || !dir) return false;
        lastVisualPosRef.current = null;
        lastArrowDirRef.current = null;

        // Check if the visual position actually changed
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
        const afterRect = sel.getRangeAt(0).getBoundingClientRect();
        const dx = Math.abs(Math.round(afterRect.left) - prev.x);
        const dy = Math.abs(Math.round(afterRect.top) - prev.y);

        // If the cursor didn't visually move, we're at a format boundary —
        // advance one more position in the same direction as the arrow key
        if (dx < 2 && dy < 2) {
          editor.update(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;

            const anchor = selection.anchor;
            const node = anchor.getNode();

            if (!$isTextNode(node)) return;

            if (dir === 'right') {
              if (anchor.offset < node.getTextContentSize()) {
                node.select(anchor.offset + 1, anchor.offset + 1);
              } else {
                const next = node.getNextSibling();
                if (next && $isTextNode(next) && next.getTextContentSize() > 0) {
                  next.select(1, 1);
                }
              }
            } else {
              if (anchor.offset > 0) {
                node.select(anchor.offset - 1, anchor.offset - 1);
              } else {
                const prevSibling = node.getPreviousSibling();
                if (prevSibling && $isTextNode(prevSibling)) {
                  const len = prevSibling.getTextContentSize();
                  if (len > 0) {
                    prevSibling.select(len - 1, len - 1);
                  }
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
      // Clear any selection highlight children
      while (caret.firstChild) caret.removeChild(caret.firstChild);
      caret.style.background = '';

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

        caret.classList.remove('notees-custom-caret--line', 'notees-custom-caret--block', 'notees-custom-caret--selection');
        caret.classList.add('notees-custom-caret--pill');
        return;
      }
    }

    // ─── DOM selection ───

    const domSelection = window.getSelection();
    if (!domSelection || domSelection.rangeCount === 0) {
      caret.style.display = 'none';
      return;
    }

    // ─── Non-collapsed: selection highlight mode ───

    if (!domSelection.isCollapsed) {
      const range = domSelection.getRangeAt(0);
      const clientRects = range.getClientRects();

      if (clientRects.length === 0) {
        caret.style.display = 'none';
        return;
      }

      // Merge client rects into per-line rects
      const lineRects: { left: number; top: number; width: number; height: number }[] = [];
      for (const r of clientRects) {
        if (r.width < 1 || r.height < 1) continue;
        const last = lineRects[lineRects.length - 1];
        if (last && Math.abs(r.top - last.top) < r.height * 0.5) {
          const newLeft = Math.min(last.left, r.left);
          const newRight = Math.max(last.left + last.width, r.left + r.width);
          const newTop = Math.min(last.top, r.top);
          const newBottom = Math.max(last.top + last.height, r.top + r.height);
          last.left = newLeft;
          last.top = newTop;
          last.width = newRight - newLeft;
          last.height = newBottom - newTop;
        } else {
          lineRects.push({ left: r.left, top: r.top, width: r.width, height: r.height });
        }
      }

      if (lineRects.length === 0) {
        caret.style.display = 'none';
        return;
      }

      const overallRect = range.getBoundingClientRect();

      if (!hasPositionedRef.current) {
        caret.style.transition = 'none';
        hasPositionedRef.current = true;
        requestAnimationFrame(() => { caret.style.transition = ''; });
      }

      caret.style.display = 'block';
      caret.style.top = `${overallRect.top - editorRect.top}px`;
      caret.style.left = `${overallRect.left - editorRect.left}px`;
      caret.style.width = `${overallRect.width}px`;
      caret.style.height = `${overallRect.height}px`;
      caret.style.background = 'transparent';

      caret.classList.remove('notees-custom-caret--line', 'notees-custom-caret--block', 'notees-custom-caret--pill');
      caret.classList.add('notees-custom-caret--selection');

      // Render per-line highlight rects as children
      const existingChildren = caret.children;
      let childIdx = 0;

      for (const lr of lineRects) {
        let child: HTMLElement;
        if (childIdx < existingChildren.length) {
          child = existingChildren[childIdx] as HTMLElement;
        } else {
          child = document.createElement('div');
          child.className = 'notees-caret-selection-line';
          caret.appendChild(child);
        }
        child.style.left = `${lr.left - overallRect.left}px`;
        child.style.top = `${lr.top - overallRect.top}px`;
        child.style.width = `${lr.width}px`;
        child.style.height = `${lr.height}px`;
        childIdx++;
      }

      // Remove extra children from previous renders
      while (caret.children.length > childIdx) {
        caret.removeChild(caret.lastChild!);
      }

      return;
    }

    // ─── Collapsed: clear selection children, restore caret ───

    while (caret.firstChild) caret.removeChild(caret.firstChild);
    caret.style.background = '';
    caret.classList.remove('notees-custom-caret--selection');

    const range = domSelection.getRangeAt(0);
    let rect: DOMRect;
    const { startContainer, startOffset } = range;

    if (overwriteMode) {
      if (
        startContainer.nodeType === Node.TEXT_NODE &&
        startOffset < (startContainer.textContent?.length ?? 0)
      ) {
        const charRange = document.createRange();
        charRange.setStart(startContainer, startOffset);
        charRange.setEnd(startContainer, startOffset + 1);
        rect = charRange.getBoundingClientRect();
        if (rect.width < 1) rect = range.getBoundingClientRect();
      } else {
        rect = range.getBoundingClientRect();
      }
    } else {
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

    // Elastic bounce on block/line jumps (vertical position change > 10px)
    const prevTop = prevTopRef.current;
    prevTopRef.current = top;

    if (prevTop !== null && hasPositionedRef.current) {
      const deltaY = top - prevTop;
      if (Math.abs(deltaY) > 10) {
        caret.animate(
          [
            { transform: `translateY(${deltaY > 0 ? -3 : 3}px)` },
            { transform: 'translateY(0.8px)' },
            { transform: 'translateY(0)' },
          ],
          { duration: 280, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
        );
      }
    }

    caret.style.display = 'block';
    caret.style.top = `${top}px`;
    caret.style.left = `${left}px`;
    caret.style.height = `${height}px`;

    // Remove pill/selection classes
    caret.classList.remove('notees-custom-caret--pill', 'notees-custom-caret--selection');

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
      hasPositionedRef.current = false;
      prevTopRef.current = null; // Reset so re-focus doesn't trigger bounce
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

  // ─── Listen for CSS transitions (indent/outdent) ──────────────
  // Track ongoing transitions and update caret continuously during them

  useEffect(() => {
    const rootElement = editor.getRootElement();
    if (!rootElement) return;

    const transitioningElements = new Set<Element>();
    let transitionRaf: number = 0;

    // Update caret continuously while any transitions are active
    const updateDuringTransition = () => {
      if (transitioningElements.size > 0) {
        updateCaretPosition();
        transitionRaf = requestAnimationFrame(updateDuringTransition);
      }
    };

    const onTransitionStart = (e: TransitionEvent) => {
      // Only respond to margin-left transitions (indent/outdent)
      if (e.propertyName === 'margin-left' && e.target instanceof Element) {
        transitioningElements.add(e.target);
        // Start continuous updates if not already running
        if (transitionRaf === 0) {
          transitionRaf = requestAnimationFrame(updateDuringTransition);
        }
      }
    };

    const onTransitionEnd = (e: TransitionEvent) => {
      // Only respond to margin-left transitions (indent/outdent)
      if (e.propertyName === 'margin-left' && e.target instanceof Element) {
        transitioningElements.delete(e.target);
        // Final update after transition completes
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(updateCaretPosition);
        // Stop continuous updates if no more transitions
        if (transitioningElements.size === 0 && transitionRaf !== 0) {
          cancelAnimationFrame(transitionRaf);
          transitionRaf = 0;
        }
      }
    };

    rootElement.addEventListener('transitionstart', onTransitionStart, true);
    rootElement.addEventListener('transitionend', onTransitionEnd, true);

    return () => {
      rootElement.removeEventListener('transitionstart', onTransitionStart, true);
      rootElement.removeEventListener('transitionend', onTransitionEnd, true);
      if (transitionRaf !== 0) {
        cancelAnimationFrame(transitionRaf);
      }
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
