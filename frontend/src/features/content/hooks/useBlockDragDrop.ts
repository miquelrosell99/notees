/**
 * useBlockDragDrop — React hook for block-level drag & drop.
 *
 * Extracted from the legacy DragDropPlugin (which was tied to a single
 * editor instance). This version works on any DOM container that contains
 * `.node-block[data-block-id]` elements with `.bullet-wrapper` drag handles.
 *
 * Preserves all original UX:
 * - Ghost preview with multi-drag support
 * - Drop-anchor computation (before / after / child)
 * - Auto-scroll
 * - Touch long-press → drag
 * - Touch long-press without movement → context menu
 */

import { useEffect, useRef, type RefObject } from 'react';
import type { DropAnchor, DragState } from './useBlockDragDrop.utils';
import { createDragEngine, type DragDropRefs } from './useBlockDragDrop.engine';
import { createTouchHandlers } from './useBlockDragDrop.touch';

export interface UseBlockDragDropOptions {
  containerRef: RefObject<HTMLElement | null>;
  editorId: string;
  readOnly?: boolean;
  /** Block IDs that should be excluded from drag interactions (e.g. ghost blocks). */
  excludedIds?: string[];
}

export function useBlockDragDrop({ containerRef, editorId, readOnly, excludedIds }: UseBlockDragDropOptions): void {
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const anchorsRef = useRef<DropAnchor[]>([]);
  const activeAnchorRef = useRef<DropAnchor | null>(null);
  const lastMouseRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const autoScrollRafRef = useRef<number | null>(null);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const excludedIdsRef = useRef<Set<string>>(new Set());
  const spacerElRef = useRef<{ el: HTMLElement; cls: string } | null>(null);
  const dragStateRef = useRef<DragState | null>(null);

  // Ghost element lifecycle
  useEffect(() => {
    const ghost = document.createElement('div');
    ghost.className = 'block-drag-ghost';
    document.body.appendChild(ghost);
    ghostRef.current = ghost;
    return () => ghost.remove();
  }, []);

  // Main drag effect
  useEffect(() => {
    excludedIdsRef.current = new Set(excludedIds ?? []);
  }, [excludedIds]);

  useEffect(() => {
    if (readOnly) return;
    const rootEl = containerRef.current;
    if (!rootEl) return;

    const refs: DragDropRefs = {
      ghostRef,
      anchorsRef,
      activeAnchorRef,
      lastMouseRef,
      autoScrollRafRef,
      scrollContainerRef,
      excludedIdsRef,
      spacerElRef,
      dragStateRef,
    };

    const engine = createDragEngine(rootEl, editorId, refs);
    const touch = createTouchHandlers(rootEl, editorId, refs, engine);

    rootEl.addEventListener('mousedown', engine.handleMouseDown, true);
    document.addEventListener('mousemove', engine.handleMouseMove);
    document.addEventListener('mouseup', engine.handleMouseUp);
    document.addEventListener('keydown', engine.handleKeyDown);
    rootEl.addEventListener('touchstart', touch.handleTouchStart, { passive: true });

    return () => {
      rootEl.removeEventListener('mousedown', engine.handleMouseDown, true);
      document.removeEventListener('mousemove', engine.handleMouseMove);
      document.removeEventListener('mouseup', engine.handleMouseUp);
      document.removeEventListener('keydown', engine.handleKeyDown);
      rootEl.removeEventListener('touchstart', touch.handleTouchStart);
      document.removeEventListener('touchmove', touch.onTouchMoveDrag);
      document.removeEventListener('touchend', touch.onTouchEndDrag);
      document.removeEventListener('touchcancel', touch.onTouchEndDrag);
      touch.cancelLongPress();
      engine.stopAutoScroll();
    };
  }, [containerRef, editorId, readOnly]);
}
