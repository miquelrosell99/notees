/**
 * useBlockDragDrop touch handlers
 */

import { flushAllContentSaves } from '@/hooks/contentSaveTracker';
import {
  findBlockRow,
  findScrollableAncestor,
  collectDragSubtreeIds,
  collectTopLevelSelectedBlocks,
  LONG_PRESS_CANCEL_PX,
  LONG_PRESS_MS,
} from './useBlockDragDrop.utils';
import { buildGhostContent } from './useBlockDragDrop.anchors';
import type { DragDropRefs, DragDropHelpers } from './useBlockDragDrop.engine';
import type { DropAnchor } from './useBlockDragDrop.utils';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function vibrateIfAllowed(pattern: number | number[]) {
  if (typeof window === 'undefined' || window.matchMedia(REDUCED_MOTION_QUERY).matches) return;
  navigator.vibrate?.(pattern);
}

export function createTouchHandlers(
  rootEl: HTMLElement,
  editorId: string,
  refs: DragDropRefs,
  helpers: DragDropHelpers,
  onDrop?: (anchor: DropAnchor, blockIds: string[]) => void | Promise<void>,
) {
  const {
    ghostRef,
    activeAnchorRef,
    lastMouseRef,
    scrollContainerRef,
    excludedIdsRef,
    dragStateRef,
  } = refs;

  const {
    recomputeAnchors,
    updateGhostPosition,
    positionGhostFloat,
    startAutoScroll,
    handleScroll,
    cleanup,
  } = helpers;

  let longPressTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelLongPress() {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function activateTouchDrag(state: NonNullable<typeof dragStateRef.current>, x: number, y: number) {
    if (!rootEl) return;
    state.longPressPending = false;
    state.active = true;
    vibrateIfAllowed(30);
    window.getSelection()?.removeAllRanges();

    // Legacy DragCoordinator lifecycle removed; drops are reported through onDrop.
    void editorId;
    const isMultiDrag = state.topLevelIds.length > 1;

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
    positionGhostFloat(ghost, x, y);

    subtreeIds.forEach((id) => {
      const el = document.querySelector(`.node-block[data-block-id="${id}"]`);
      el?.classList.add('node-block--drag-source');
    });
    document.body.classList.add('notees-dragging-block');

    const sc = scrollContainerRef.current;
    if (sc) sc.addEventListener('scroll', handleScroll, { passive: true });
    startAutoScroll();
  }

  function onTouchMoveDrag(e: TouchEvent) {
    const state = dragStateRef.current;
    if (!state) return;
    const touch = e.touches[0];
    lastMouseRef.current = { x: touch.clientX, y: touch.clientY };

    if (state.pending) {
      const dx = touch.clientX - state.startX;
      const dy = touch.clientY - state.startY;
      if (Math.sqrt(dx * dx + dy * dy) > LONG_PRESS_CANCEL_PX) {
        cancelLongPress();
        document.removeEventListener('touchmove', onTouchMoveDrag);
        document.removeEventListener('touchend', onTouchEndDrag);
        document.removeEventListener('touchcancel', onTouchEndDrag);
        dragStateRef.current = null;
      }
      return;
    }

    if (state.longPressPending) {
      activateTouchDrag(state, touch.clientX, touch.clientY);
      e.preventDefault();
      updateGhostPosition(touch.clientX, touch.clientY);
      return;
    }

    if (state.active) {
      e.preventDefault();
      updateGhostPosition(touch.clientX, touch.clientY);
    }
  }

  async function onTouchEndDrag(_e?: TouchEvent) {
    cancelLongPress();
    document.removeEventListener('touchmove', onTouchMoveDrag);
    document.removeEventListener('touchend', onTouchEndDrag);
    document.removeEventListener('touchcancel', onTouchEndDrag);

    const state = dragStateRef.current;
    dragStateRef.current = null;
    if (!state) return;

    if (state.active) {
      const anchor = activeAnchorRef.current;
      const blockIds = state.topLevelIds.length > 1 ? state.topLevelIds : [state.blockId];
      if (anchor && onDrop) {
        flushAllContentSaves();
        await onDrop(anchor, blockIds);
      }
      cleanup(state);
      return;
    }

    if (state.longPressPending) {
      const bulletEl = state.blockEl.querySelector<HTMLElement>('.bullet-wrapper');
      if (bulletEl) {
        bulletEl.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: state.startX,
            clientY: state.startY,
          }),
        );
      }
      return;
    }
  }

  const handleTouchStart = (e: TouchEvent) => {
    const target = e.target as HTMLElement;
    const bullet = target.closest('.bullet-wrapper') as HTMLElement | null;
    if (!bullet || target.closest('.block-collapse-arrow')) return;

    const blockEl = findBlockRow(bullet);
    if (!blockEl) return;
    const blockId = blockEl.getAttribute('data-block-id');
    if (!blockId) return;
    if (dragStateRef.current) return;

    const touch = e.touches[0];
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
      startX: touch.clientX,
      startY: touch.clientY,
      blockId,
      blockEl,
      sourceDepth: depth,
      ghostText,
      snapped: false,
      topLevelIds,
    };

    document.addEventListener('touchmove', onTouchMoveDrag, { passive: false });
    document.addEventListener('touchend', onTouchEndDrag, { passive: true });
    document.addEventListener('touchcancel', onTouchEndDrag, { passive: true });

    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      const st = dragStateRef.current;
      if (!st || !st.pending) return;
      st.pending = false;
      st.longPressPending = true;
      vibrateIfAllowed(20);
    }, LONG_PRESS_MS);
  };

  return {
    handleTouchStart,
    onTouchMoveDrag,
    onTouchEndDrag,
    cancelLongPress,
  };
}
