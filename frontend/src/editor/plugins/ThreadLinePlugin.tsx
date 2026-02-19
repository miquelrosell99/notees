/**
 * ThreadLinePlugin — Logseq-style vertical thread lines.
 *
 * For each expanded block that has visible children, renders a thin
 * clickable vertical line aligned with its bullet. The line spans the
 * full height of the block's descendant subtree. Clicking it collapses
 * the parent block.
 *
 * • Only active in 'list' mode (not 'document').
 * • Uses DOM measurement (getBoundingClientRect) so it is scroll-safe.
 * • A single requestAnimationFrame debounce batches rapid Lexical updates.
 */

import { useEffect, useCallback, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';

export interface ThreadLinePluginProps {
  /** Only render lines in list mode; document mode hides bullets entirely */
  mode?: 'list' | 'document';
}

export function ThreadLinePlugin({ mode = 'list' }: ThreadLinePluginProps): null {
  const [editor] = useLexicalComposerContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);

  // ─── Core drawing logic ──────────────────────────────────────────

  const updateLines = useCallback(() => {
    if (mode !== 'list') {
      containerRef.current?.remove();
      containerRef.current = null;
      return;
    }

    // The Lexical root element is the ContentEditable div (.notees-editor-content)
    const editorContent = editor.getRootElement();
    if (!editorContent) return;

    // Walk up to the .notees-editor wrapper (position: relative anchor)
    const editorWrapper = editorContent.closest<HTMLElement>('.notees-editor');
    if (!editorWrapper) return;

    // Get or create the overlay container (direct child of .notees-editor)
    let container = containerRef.current;
    if (!container || !editorWrapper.contains(container)) {
      container = document.createElement('div');
      container.className = 'thread-lines-container';
      editorWrapper.appendChild(container);
      containerRef.current = container;
    }

    // Positions of lines are relative to the wrapper element
    const wrapperRect = editorWrapper.getBoundingClientRect();

    // Collect all rendered block elements in DOM order
    const allBlocks = Array.from(
      editorContent.querySelectorAll<HTMLElement>('.node-block'),
    );

    // Build lines
    // We reuse a DocumentFragment to minimise reflow
    const frag = document.createDocumentFragment();

    for (let i = 0; i < allBlocks.length; i++) {
      const block = allBlocks[i];

      // Only blocks that have children AND are not collapsed
      if (!block.classList.contains('node-block--has-children')) continue;
      if (block.classList.contains('node-block--collapsed')) continue;

      const depth = parseInt(block.dataset.depth ?? '0', 10);
      const blockId = block.dataset.blockId;
      if (!blockId) continue;

      const bullet = block.querySelector<HTMLElement>('.bullet-wrapper');
      if (!bullet) continue;

      // Scan forward for the last block in this block's entire descendant subtree
      let lastDescendant: HTMLElement | null = null;
      for (let j = i + 1; j < allBlocks.length; j++) {
        const sib = allBlocks[j];
        const sibDepth = parseInt(sib.dataset.depth ?? '0', 10);
        if (sibDepth <= depth) break;
        lastDescendant = sib;
      }
      if (!lastDescendant) continue;

      const bulletRect = bullet.getBoundingClientRect();
      const lastBullet = lastDescendant.querySelector<HTMLElement>('.bullet-wrapper');
      const lastRect = (lastBullet ?? lastDescendant).getBoundingClientRect();

      // All coordinates relative to the editor wrapper
      // (getBoundingClientRect difference is scroll-safe)
      const lineX = bulletRect.left - wrapperRect.left + bulletRect.width / 2;
      const lineTop = bulletRect.top - wrapperRect.top + bulletRect.height;
      const lineBottom =
        lastRect.top - wrapperRect.top + lastRect.height / 2;

      if (lineBottom <= lineTop) continue;

      const line = document.createElement('div');
      line.className = 'thread-line';
      line.title = 'Toggle collapse children';
      line.dataset.blockId = blockId;
      line.style.left = `${lineX}px`;
      line.style.top = `${lineTop}px`;
      line.style.height = `${lineBottom - lineTop}px`;

      line.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const runtime = getNodeGraphRuntime();
        const children = runtime.getChildren(blockId);
        if (children.length === 0) return;
        // If any child is expanded, collapse all; otherwise expand all
        const anyExpanded = children.some(child => !child.collapsed);
        runtime.applyIntent({
          type: 'batch',
          intents: children.map(child => ({
            type: 'set_collapsed' as const,
            blockId: child.blockId,
            collapsed: anyExpanded,
          })),
        });
      });

      frag.appendChild(line);
    }

    // Swap content in one operation to minimise flicker
    container.replaceChildren(frag);
  }, [editor, mode]);

  // ─── Debounced schedule ──────────────────────────────────────────

  const scheduleUpdate = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      updateLines();
    });
  }, [updateLines]);

  // Re-draw whenever the Lexical tree changes
  useEffect(() => {
    return editor.registerUpdateListener(() => scheduleUpdate());
  }, [editor, scheduleUpdate]);

  // Re-draw on window resize
  useEffect(() => {
    scheduleUpdate();
    window.addEventListener('resize', scheduleUpdate);
    return () => {
      window.removeEventListener('resize', scheduleUpdate);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [scheduleUpdate]);

  // Clean up the overlay when the plugin unmounts
  useEffect(() => {
    return () => {
      containerRef.current?.remove();
      containerRef.current = null;
    };
  }, []);

  return null;
}
