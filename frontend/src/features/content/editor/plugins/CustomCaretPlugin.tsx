/**
 * CustomCaretPlugin — Fully replaces the native browser caret with a custom one.
 *
 * Features:
 * - **Normal mode**: Thin vertical line caret (2px wide, rounded corners)
 * - **Insert mode**: Block caret covering the character (Insert key toggle)
 * - **Pill surround**: When navigating onto a node link, caret smoothly wraps it
 * - **Breathing blink**: Sine-eased opacity pulse
 * - **Active block tracking**: Adds class to focused block for bullet pulse
 * - Theme-aware styling via --color-on-surface token
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
import { $isInlineLinkNode } from '@/features/content/editor/nodes/InlineLinkNode';
import './CustomCaretPlugin.css';

// ─── Editing trail tracking ───────────────────────────────────────

const trailBlocksRef: { current: HTMLElement[] } = { current: [] };

function clearEditingTrail() {
  for (const el of trailBlocksRef.current) {
    el.classList.remove('node-block--editing-trail');
  }
  trailBlocksRef.current = [];
}

function setEditingTrail(activeBlock: HTMLElement | null) {
  clearEditingTrail();
  if (!activeBlock) return;

  const container = activeBlock.closest('.block-list');
  if (!container) return;

  const allBlocks = Array.from(container.querySelectorAll('.node-block')) as HTMLElement[];
  const activeIndex = allBlocks.indexOf(activeBlock);
  if (activeIndex < 0) return;

  const activeDepth = parseInt(activeBlock.getAttribute('data-depth') || '0', 10);
  let expectedDepth = activeDepth - 1;

  for (let i = activeIndex - 1; i >= 0 && expectedDepth >= 0; i--) {
    const block = allBlocks[i];
    const depth = parseInt(block.getAttribute('data-depth') || '0', 10);
    if (depth === expectedDepth) {
      block.classList.add('node-block--editing-trail');
      trailBlocksRef.current.push(block);
      expectedDepth--;
    }
  }
}

// ─── Component ──────────────────────────────────────────────────

export function CustomCaretPlugin({ readOnly = false }: { readOnly?: boolean }): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [overwriteMode, setOverwriteMode] = useState(false);
  const caretRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number>(0);
  // Microtask-based batching flag for critical update paths
  const microPendingRef = useRef(false);
  // Track whether we've set an initial position (skip transition on first placement)
  const hasPositionedRef = useRef(false);
  // Track previous Y position for elastic bounce on block jumps
  const prevTopRef = useRef<number | null>(null);
  // Track the currently active block element for bullet pulse
  const activeBlockRef = useRef<HTMLElement | null>(null);
  // Track whether the caret was in pill mode on the previous update
  const wasPillRef = useRef(false);
  // Track the currently highlighted styled text span (cursor-inside indicator)
  const activeStyledNodeRef = useRef<HTMLElement | null>(null);
  // No editorRootRef needed — we position relative to the caret's offsetParent
  // so the plugin works correctly inside both monolithic and per-block editors.

  // ─── Track active block for bullet pulse ─────────────────────

  const updateActiveBlock = useCallback(() => {
    const rootElement = editor.getRootElement();
    if (!rootElement) return;

    const domSelection = window.getSelection();
    let newBlock: HTMLElement | null = null;

    if (domSelection && domSelection.rangeCount > 0) {
      const anchorNode = domSelection.anchorNode;
      if (anchorNode) {
        const el = anchorNode.nodeType === Node.TEXT_NODE ? anchorNode.parentElement : anchorNode as Element;
        newBlock = el?.closest('.node-block') as HTMLElement | null;
      }
    }

    if (newBlock !== activeBlockRef.current) {
      activeBlockRef.current?.classList.remove('node-block--editing');
      clearEditingTrail();
      newBlock?.classList.add('node-block--editing');
      setEditingTrail(newBlock);
      activeBlockRef.current = newBlock;
    }
  }, [editor]);

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
                  next.select(0, 0);
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
                    prevSibling.select(len, len);
                  }
                }
              }
            }
          });
        }

        return false;
      },
      COMMAND_PRIORITY_HIGH,
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

    // Position relative to the caret's offsetParent (nearest positioned ancestor).
    // This ensures correct coordinates regardless of whether the caret lives inside
    // a per-block InlineEditor or the monolithic BlockEditor.
    // NOTE: The caret's CSS default is display:none, so offsetParent returns null.
    // We briefly show it to discover its containing block.
    const savedDisplay = caret.style.display;
    caret.style.display = 'block';
    const offsetParent = caret.offsetParent as HTMLElement | null;
    caret.style.display = savedDisplay;
    if (!offsetParent) {
      caret.style.display = 'none';
      return;
    }
    const parentRect = offsetParent.getBoundingClientRect();

    // ─── Single read() to gather all Lexical state ───
    let isPillSelected = false;
    let hasFormat = false;
    let lexicalIsCollapsed = true;
    editor.getEditorState().read(() => {
      const selection = $getSelection();
      if ($isNodeSelection(selection)) {
        const nodes = selection.getNodes();
        isPillSelected = nodes.length === 1 && $isInlineLinkNode(nodes[0]);
      } else if ($isRangeSelection(selection)) {
        lexicalIsCollapsed = selection.isCollapsed();
        if (lexicalIsCollapsed) {
          hasFormat = selection.format !== 0;
        }
      }
    });

    if (isPillSelected) {
      // Clear any selection highlight children
      while (caret.firstChild) caret.removeChild(caret.firstChild);
      caret.style.background = '';

      const selectedPill = rootElement.querySelector('.inline-link-wrapper.selected, .inline-link-wrapper--selected');
      if (selectedPill) {
        const pillRect = selectedPill.getBoundingClientRect();
        const padding = 3;

        // Disable position transitions on first placement
        if (!hasPositionedRef.current) {
          caret.style.transition = 'none';
          hasPositionedRef.current = true;
          requestAnimationFrame(() => { caret.style.transition = ''; });
        }

        wasPillRef.current = true;

        const tx = pillRect.left - parentRect.left - padding;
        const ty = pillRect.top - parentRect.top - padding;

        caret.style.display = 'block';
        caret.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
        caret.style.width = `${pillRect.width + padding * 2}px`;
        caret.style.height = `${pillRect.height + padding * 2}px`;

        // Clear span highlight when entering pill mode
        activeStyledNodeRef.current?.classList.remove('notees-text--cursor-inside');
        activeStyledNodeRef.current = null;

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

    if (!domSelection.isCollapsed && !lexicalIsCollapsed) {
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

      // Compute overall bounding rect from the merged line rects instead of
      // calling getBoundingClientRect() again (saves one forced layout/reflow).
      const overallLeft = Math.min(...lineRects.map(r => r.left));
      const overallTop = Math.min(...lineRects.map(r => r.top));
      const overallRight = Math.max(...lineRects.map(r => r.left + r.width));
      const overallBottom = Math.max(...lineRects.map(r => r.top + r.height));
      const overallRect = {
        top: overallTop,
        left: overallLeft,
        width: overallRight - overallLeft,
        height: overallBottom - overallTop,
      };

      if (!hasPositionedRef.current) {
        caret.style.transition = 'none';
        hasPositionedRef.current = true;
        requestAnimationFrame(() => { caret.style.transition = ''; });
      }

      const selTx = overallRect.left - parentRect.left;
      const selTy = overallRect.top - parentRect.top;

      caret.style.display = 'block';
      caret.style.transform = `translate3d(${selTx}px, ${selTy}px, 0)`;
      caret.style.width = `${overallRect.width}px`;
      caret.style.height = `${overallRect.height}px`;
      caret.style.background = 'transparent';

      // Clear span highlight when selection is non-collapsed
      activeStyledNodeRef.current?.classList.remove('notees-text--cursor-inside');
      activeStyledNodeRef.current = null;

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

    // Resolve the text element once for both height fallback and line-height clamping
    const textEl = startContainer.nodeType === Node.TEXT_NODE
      ? startContainer.parentElement
      : startContainer as Element;

    // Compute line height once (used for both fallback and clamping)
    let computedLineHeight = 40; // sensible default
    if (textEl) {
      const cs = getComputedStyle(textEl);
      const lh = parseFloat(cs.lineHeight);
      const fs = parseFloat(cs.fontSize);
      computedLineHeight = !isNaN(lh) ? lh : (!isNaN(fs) ? fs * 1.6 : 40);
    }

    // Height fallback for format boundaries
    if (rect.height < 1) {
      if (textEl) {
        const parentRect = textEl.getBoundingClientRect();
        rect = new DOMRect(
          rect.left || parentRect.left,
          parentRect.top,
          rect.width || 2,
          computedLineHeight
        );
      } else {
        rect = new DOMRect(rect.left, rect.top, rect.width || 2, 20);
      }
    }

    // ─── Empty-block left-position fix ───
    const anchorEl = textEl;
    let contentEl = anchorEl?.closest('.node-block-content') as HTMLElement | null;
    if (!contentEl) {
      const blockEl = anchorEl?.closest('.node-block') as HTMLElement | null;
      contentEl = blockEl?.querySelector('.node-block-content') as HTMLElement | null;
    }
    if (contentEl) {
      const contentLeft = contentEl.getBoundingClientRect().left;
      if (rect.left < contentLeft) {
        rect = new DOMRect(contentLeft, rect.top, rect.width, rect.height);
      }
    }

    // ─── Pill-adjacent position fix ───
    // When the cursor sits in a text node with no visible content (ZWS or
    // empty) next to a pill (contentEditable=false InlineLinkNode),
    // getBoundingClientRect() returns unreliable results — often {0,0,0,0}
    // or a position inside the pill.  Snap the caret to the pill's edge
    // using the pill's own bounding rect which is always reliable.
    if (startContainer.nodeType === Node.TEXT_NODE && textEl) {
      const text = startContainer.textContent ?? '';
      const hasNoVisibleContent = text === '\u200B' || text === '';

      if (hasNoVisibleContent) {
        const prevSib = textEl.previousElementSibling;
        const nextSib = textEl.nextElementSibling;
        if (prevSib?.classList?.contains('inline-link-wrapper')) {
          // Cursor is after a pill → snap to pill's right edge
          const pillRect = prevSib.getBoundingClientRect();
          rect = new DOMRect(
            pillRect.right,
            rect.height > 1 ? rect.top : pillRect.top,
            rect.width,
            rect.height > 1 ? rect.height : pillRect.height,
          );
        } else if (nextSib?.classList?.contains('inline-link-wrapper')) {
          // Cursor is before a pill → snap to pill's left edge
          const pillRect = nextSib.getBoundingClientRect();
          rect = new DOMRect(
            pillRect.left,
            rect.height > 1 ? rect.top : pillRect.top,
            rect.width,
            rect.height > 1 ? rect.height : pillRect.height,
          );
        }
      }
    }

    const top = rect.top - parentRect.top;
    const left = rect.left - parentRect.left;
    
    // Clamp height to line height to avoid spanning images below text
    const height = rect.height > 1 ? Math.min(rect.height, computedLineHeight) : 20;

    // Disable position transitions on first placement or when exiting pill mode
    if (!hasPositionedRef.current || wasPillRef.current) {
      caret.style.transition = 'none';
      hasPositionedRef.current = true;
      wasPillRef.current = false;
      requestAnimationFrame(() => { caret.style.transition = ''; });
    }

    // Elastic bounce on block/line jumps (vertical position change > 10px)
    const prevTop = prevTopRef.current;
    prevTopRef.current = top;

    if (prevTop !== null && hasPositionedRef.current) {
      const deltaY = top - prevTop;
      if (Math.abs(deltaY) > 10) {
        // Use a separate animation so it doesn't interfere with translate3d positioning
        caret.animate(
          [
            { transform: `translate3d(${left}px, ${top + (deltaY > 0 ? -3 : 3)}px, 0)` },
            { transform: `translate3d(${left}px, ${top + 0.8}px, 0)` },
            { transform: `translate3d(${left}px, ${top}px, 0)` },
          ],
          { duration: 200, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
        );
      }
    }

    caret.style.display = 'block';
    caret.style.transform = `translate3d(${left}px, ${top}px, 0)`;
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

    // ─── Styled-span underline indicator ─────────────────────────────
    // hasFormat was already computed in the single read() above
    let newStyledEl: HTMLElement | null = null;
    if (hasFormat) {
      const domSel = window.getSelection();
      if (domSel && domSel.rangeCount > 0 && domSel.isCollapsed) {
        const anchorDomNode = domSel.anchorNode;
        if (anchorDomNode?.nodeType === Node.TEXT_NODE) {
          newStyledEl = anchorDomNode.parentElement;
        }
      }
    }

    // Swap highlight
    const prevStyledEl = activeStyledNodeRef.current;
    if (prevStyledEl !== newStyledEl) {
      prevStyledEl?.classList.remove('notees-text--cursor-inside');
      newStyledEl?.classList.add('notees-text--cursor-inside');
      activeStyledNodeRef.current = newStyledEl;
    }
  }, [editor, overwriteMode]);

  // ─── Listen for selection changes ────────────────────────────

  // Schedule caret update via microtask (runs before next paint, no 1-frame lag)
  const scheduleCaretMicrotask = useCallback(() => {
    if (!microPendingRef.current) {
      microPendingRef.current = true;
      queueMicrotask(() => {
        microPendingRef.current = false;
        updateCaretPosition();
        updateActiveBlock();
      });
    }
  }, [updateCaretPosition, updateActiveBlock]);

  useEffect(() => {
    const unregisterSelection = editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        scheduleCaretMicrotask();
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );

    // Note: registerUpdateListener is intentionally omitted here.
    // SELECTION_CHANGE_COMMAND covers all cases where the caret must move
    // (typing, formatting, arrow keys) because Lexical always dispatches it
    // alongside content/selection mutations. Adding an update listener would
    // double-schedule caret updates and cause extra forced layouts.

    // Initial position
    requestAnimationFrame(() => {
      updateCaretPosition();
      updateActiveBlock();
    });

    return () => {
      unregisterSelection();
      cancelAnimationFrame(rafRef.current);
    };
  }, [editor, scheduleCaretMicrotask, updateCaretPosition, updateActiveBlock]);

  // ─── Listen for focus/blur events ────────────────────────────

  useEffect(() => {
    const rootElement = editor.getRootElement();
    if (!rootElement) return;

    const onFocus = () => {
      hasPositionedRef.current = false;
      prevTopRef.current = null;
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        updateCaretPosition();
        updateActiveBlock();
      });
    };

    const onBlur = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(updateCaretPosition);
      // Remove active block class on blur
      activeBlockRef.current?.classList.remove('node-block--editing');
      clearEditingTrail();
      activeBlockRef.current = null;
      // Remove styled span highlight on blur
      activeStyledNodeRef.current?.classList.remove('notees-text--cursor-inside');
      activeStyledNodeRef.current = null;
    };

    rootElement.addEventListener('focus', onFocus, true);
    rootElement.addEventListener('blur', onBlur, true);

    return () => {
      rootElement.removeEventListener('focus', onFocus, true);
      rootElement.removeEventListener('blur', onBlur, true);
    };
  }, [editor, updateCaretPosition, updateActiveBlock]);

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

  // ─── Cleanup on unmount ──────────────────────────────────────

  useEffect(() => {
    return () => {
      activeBlockRef.current?.classList.remove('node-block--editing');
      clearEditingTrail();
      activeStyledNodeRef.current?.classList.remove('notees-text--cursor-inside');
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
