/**
 * useBlockDragDrop engine — shared helpers and mouse event handlers
 */

import { getDragCoordinator } from '@/runtime/DragCoordinator';
import {
  findBlockRow,
  findScrollableAncestor,
  collectDragSubtreeIds,
  collectTopLevelSelectedBlocks,
  AUTO_SCROLL_EDGE,
  AUTO_SCROLL_SPEED,
  DRAG_THRESHOLD,
  type DragState,
  type DropAnchor,
} from './useBlockDragDrop.utils';
import { computeDropAnchors, findNearestAnchor, buildGhostContent } from './useBlockDragDrop.anchors';
import type { MutableRefObject } from 'react';

export interface DragDropRefs {
  ghostRef: MutableRefObject<HTMLDivElement | null>;
  anchorsRef: MutableRefObject<DropAnchor[]>;
  activeAnchorRef: MutableRefObject<DropAnchor | null>;
  lastMouseRef: MutableRefObject<{ x: number; y: number }>;
  autoScrollRafRef: MutableRefObject<number | null>;
  scrollContainerRef: MutableRefObject<HTMLElement | null>;
  excludedIdsRef: MutableRefObject<Set<string>>;
  spacerElRef: MutableRefObject<{ el: HTMLElement; cls: string } | null>;
  dragStateRef: MutableRefObject<DragState | null>;
}

export interface DragDropHelpers {
  recomputeAnchors: () => void;
  updateGhostPosition: (cx: number, cy: number) => void;
  applyDropSpacing: (anchor: DropAnchor) => void;
  clearDropSpacing: () => void;
  positionGhostFloat: (ghost: HTMLDivElement, cx: number, cy: number) => void;
  startAutoScroll: () => void;
  stopAutoScroll: () => void;
  handleScroll: () => void;
  cleanup: (state: DragState) => void;
}

export function createDragEngine(
  rootEl: HTMLElement,
  editorId: string,
  refs: DragDropRefs,
): DragDropHelpers & {
  handleMouseDown: (e: MouseEvent) => void;
  handleMouseMove: (e: MouseEvent) => void;
  handleMouseUp: (e: MouseEvent) => void;
  handleKeyDown: (e: KeyboardEvent) => void;
} {
  const {
    ghostRef,
    anchorsRef,
    activeAnchorRef,
    lastMouseRef,
    autoScrollRafRef,
    scrollContainerRef,
    excludedIdsRef,
    spacerElRef,
    dragStateRef,
  } = refs;

  function recomputeAnchors() {
    const allAnchors = computeDropAnchors(rootEl, excludedIdsRef.current, editorId);
    anchorsRef.current = allAnchors;
  }

  function updateGhostPosition(cx: number, cy: number) {
    const state = dragStateRef.current;
    if (!state?.active) return;
    const ghost = ghostRef.current;
    if (!ghost) return;

    const coordinator = getDragCoordinator();
    const anchor = findNearestAnchor(anchorsRef.current, cx, cy);

    if (anchor) {
      coordinator.updateTarget(anchor.target);
      ghost.classList.add('block-drag-ghost--snapped');
      ghost.classList.remove('block-drag-ghost--floating');
      ghost.style.transition = 'none';
      ghost.style.left = `${anchor.x - 11}px`;
      ghost.style.width = '200px';
      state.snapped = true;
      activeAnchorRef.current = anchor;
      ghost.style.top = `${anchor.y}px`;
      applyDropSpacing(anchor);
    } else {
      coordinator.updateTarget(null);
      positionGhostFloat(ghost, cx, cy);
      state.snapped = false;
      activeAnchorRef.current = null;
      clearDropSpacing();
    }
  }

  function applyDropSpacing(anchor: DropAnchor) {
    const { blockId, position } = anchor.target;
    const targetEl = document.querySelector(
      `.node-block[data-block-id="${blockId}"]`,
    ) as HTMLElement | null;
    if (!targetEl) {
      clearDropSpacing();
      return;
    }
    const cls =
      position === 'before'
        ? 'node-block--drop-spacing-before'
        : 'node-block--drop-spacing-after';
    const prev = spacerElRef.current;
    if (prev?.el === targetEl && prev.cls === cls) return;
    prev?.el.classList.remove(prev.cls);
    targetEl.classList.add('node-block--drop-spacing-instant');
    targetEl.classList.add(cls);
    spacerElRef.current = { el: targetEl, cls };
    requestAnimationFrame(() => targetEl.classList.remove('node-block--drop-spacing-instant'));
  }

  function clearDropSpacing() {
    const prev = spacerElRef.current;
    if (prev) {
      prev.el.classList.remove(prev.cls, 'node-block--drop-spacing-instant');
      spacerElRef.current = null;
    }
  }

  function positionGhostFloat(ghost: HTMLDivElement, cx: number, cy: number) {
    ghost.style.transition = 'none';
    ghost.classList.remove('block-drag-ghost--snapped');
    ghost.classList.add('block-drag-ghost--floating');
    ghost.style.top = `${cy - 14}px`;
    ghost.style.left = `${cx - 11}px`;
    ghost.style.width = '';
  }

  function startAutoScroll() {
    const tick = () => {
      const state = dragStateRef.current;
      if (!state?.active) {
        autoScrollRafRef.current = null;
        return;
      }
      const container = scrollContainerRef.current;
      if (!container) {
        autoScrollRafRef.current = requestAnimationFrame(tick);
        return;
      }
      const rect = container.getBoundingClientRect();
      const my = lastMouseRef.current.y;
      let scrollDelta = 0;
      if (my < rect.top + AUTO_SCROLL_EDGE && container.scrollTop > 0) {
        const proximity = 1 - Math.max(0, my - rect.top) / AUTO_SCROLL_EDGE;
        scrollDelta = -AUTO_SCROLL_SPEED * proximity;
      } else if (
        my > rect.bottom - AUTO_SCROLL_EDGE &&
        container.scrollTop < container.scrollHeight - container.clientHeight
      ) {
        const proximity = 1 - Math.max(0, rect.bottom - my) / AUTO_SCROLL_EDGE;
        scrollDelta = AUTO_SCROLL_SPEED * proximity;
      }
      if (scrollDelta !== 0) {
        container.scrollTop += scrollDelta;
        recomputeAnchors();
        updateGhostPosition(lastMouseRef.current.x, lastMouseRef.current.y);
      }
      autoScrollRafRef.current = requestAnimationFrame(tick);
    };
    autoScrollRafRef.current = requestAnimationFrame(tick);
  }

  function stopAutoScroll() {
    if (autoScrollRafRef.current !== null) {
      cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
  }

  function handleScroll() {
    const state = dragStateRef.current;
    if (!state?.active) return;
    recomputeAnchors();
    updateGhostPosition(lastMouseRef.current.x, lastMouseRef.current.y);
  }

  function cleanup(_state: NonNullable<typeof dragStateRef.current>) {
    stopAutoScroll();
    const sc = scrollContainerRef.current;
    if (sc) sc.removeEventListener('scroll', handleScroll);
    scrollContainerRef.current = null;
    const ghost = ghostRef.current;
    if (ghost) {
      ghost.style.display = 'none';
      ghost.style.transition = '';
      ghost.style.width = '';
      ghost.className = 'block-drag-ghost';
    }
    clearDropSpacing();
    excludedIdsRef.current.forEach((id) => {
      const el = document.querySelector(`.node-block[data-block-id="${id}"]`);
      el?.classList.remove('node-block--drag-source');
    });
    excludedIdsRef.current = new Set();
    document.body.classList.remove('notees-dragging-block');
    anchorsRef.current = [];
    activeAnchorRef.current = null;
    document.querySelectorAll('.block-selection-card').forEach((el) => el.remove());
  }

  // ── Mouse ───────────────────────────────────────────────────────

  const handleMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const bullet = target.closest('.bullet-wrapper') as HTMLElement | null;
    if (!bullet || target.closest('.block-collapse-arrow')) return;
    if (e.shiftKey) return;

    const blockEl = findBlockRow(bullet);
    if (!blockEl) return;
    const blockId = blockEl.getAttribute('data-block-id');
    if (!blockId) return;

    e.preventDefault();
    e.stopPropagation();

    const depth = parseInt(blockEl.getAttribute('data-depth') || '0', 10);
    const isInSelection =
      blockEl.classList.contains('node-block--selected') ||
      blockEl.classList.contains('node-block--selected-child');
    const topLevelIds = isInSelection ? collectTopLevelSelectedBlocks(rootEl) : [];
    const isMultiDrag = topLevelIds.length > 1;

    let ghostText: string;
    if (isMultiDrag) {
      const firstEl = rootEl.querySelector(
        `.node-block[data-block-id="${topLevelIds[0]}"]`,
      ) as HTMLElement | null;
      const firstText = firstEl?.querySelector('.node-block-content')?.textContent?.trim() || '';
      const short = firstText.length > 50 ? firstText.slice(0, 50) + '…' : firstText;
      ghostText = short ? `${short} (+${topLevelIds.length - 1})` : `${topLevelIds.length} blocks`;
    } else {
      const contentEl = blockEl.querySelector('.node-block-content');
      ghostText = contentEl?.textContent?.trim() || '';
      if (ghostText.length > 60) ghostText = ghostText.substring(0, 60) + '…';
    }

    dragStateRef.current = {
      pending: true,
      longPressPending: false,
      active: false,
      startX: e.clientX,
      startY: e.clientY,
      blockId,
      blockEl,
      sourceDepth: depth,
      ghostText,
      snapped: false,
      topLevelIds,
    };
  };

  const handleMouseMove = (e: MouseEvent) => {
    const state = dragStateRef.current;
    if (!state) return;
    if (!state.pending && !state.active) return;

    lastMouseRef.current = { x: e.clientX, y: e.clientY };
    const dx = e.clientX - state.startX;
    const dy = e.clientY - state.startY;

    if (state.pending) {
      if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
      state.pending = false;
      state.active = true;

      window.getSelection()?.removeAllRanges();
      const isMultiDrag = state.topLevelIds.length > 1;
      getDragCoordinator().startDrag({
        blockId: state.blockId,
        sourceEditorId: editorId,
        sourceDepth: state.sourceDepth,
        ...(isMultiDrag ? { blockIds: state.topLevelIds } : {}),
      });

      scrollContainerRef.current = findScrollableAncestor(rootEl);
      const idsToExclude = isMultiDrag ? state.topLevelIds : [state.blockId];
      const subtreeIds = new Set<string>();
      for (const bid of idsToExclude) {
        collectDragSubtreeIds(rootEl, bid).forEach((id) => subtreeIds.add(id));
      }
      excludedIdsRef.current = subtreeIds;
      recomputeAnchors();
      document.querySelectorAll('.block-selection-card').forEach((el) => el.remove());

      const ghost = ghostRef.current!;
      buildGhostContent(ghost, isMultiDrag, state.topLevelIds, state.ghostText, rootEl);
      ghost.style.display = 'flex';
      positionGhostFloat(ghost, e.clientX, e.clientY);

      subtreeIds.forEach((id) => {
        const el = document.querySelector(`.node-block[data-block-id="${id}"]`);
        el?.classList.add('node-block--drag-source');
      });
      document.body.classList.add('notees-dragging-block');

      const sc = scrollContainerRef.current;
      if (sc) sc.addEventListener('scroll', handleScroll, { passive: true });
      startAutoScroll();
    }

    if (!state.active) return;
    updateGhostPosition(e.clientX, e.clientY);
  };

  const handleMouseUp = async (_e: MouseEvent) => {
    const state = dragStateRef.current;
    if (!state) return;
    if (state.active) {
      const coordinator = getDragCoordinator();
      if (activeAnchorRef.current) {
        await coordinator.completeDrag();
      } else {
        coordinator.cancelDrag();
      }
      cleanup(state);

      const suppressClick = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener('click', suppressClick, { capture: true, once: true });
      requestAnimationFrame(() =>
        window.removeEventListener('click', suppressClick, { capture: true }),
      );
    }
    dragStateRef.current = null;
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    const state = dragStateRef.current;
    if (!state) return;
    if (state.active) {
      getDragCoordinator().cancelDrag();
      cleanup(state);
    }
    dragStateRef.current = null;
  };

  return {
    recomputeAnchors,
    updateGhostPosition,
    applyDropSpacing,
    clearDropSpacing,
    positionGhostFloat,
    startAutoScroll,
    stopAutoScroll,
    handleScroll,
    cleanup,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleKeyDown,
  };
}
