/**
 * useTouchIndent — Horizontal swipe on a bullet to indent / outdent on touch screens.
 *
 * Extracted from TouchIndentPlugin to work with a container ref instead of
 * a Lexical editor context.
 */

import { useEffect, type RefObject } from 'react';

export interface UseTouchIndentOptions {
  containerRef: RefObject<HTMLElement | null>;
  onIndent?: (blockId: string) => void;
  onOutdent?: (blockId: string) => void;
  readOnly?: boolean;
}

const THRESHOLD = 52;
const CANCEL_THRESHOLD = 22;
const LOCK_SCROLL_AFTER = 14;

export function useTouchIndent({ containerRef, onIndent, onOutdent, readOnly }: UseTouchIndentOptions): void {
  useEffect(() => {
    if (readOnly) return;
    const root = containerRef.current;
    if (!root) return;

    let startX = 0;
    let startY = 0;
    let activeBlockId: string | null = null;
    let activeBlockEl: HTMLElement | null = null;
    let committed = false;
    let scrollLocked = false;

    function applyProgress(progress: number, direction: 'indent' | 'outdent') {
      if (!activeBlockEl) return;
      activeBlockEl.style.setProperty('--swipe-progress', String(progress));
      if (direction === 'indent') {
        activeBlockEl.classList.add('node-block--swipe-indent');
        activeBlockEl.classList.remove('node-block--swipe-outdent');
      } else {
        activeBlockEl.classList.add('node-block--swipe-outdent');
        activeBlockEl.classList.remove('node-block--swipe-indent');
      }
    }

    function cleanup() {
      if (activeBlockEl) {
        activeBlockEl.classList.remove('node-block--swipe-indent', 'node-block--swipe-outdent');
        activeBlockEl.style.removeProperty('--swipe-progress');
      }
      activeBlockId = null;
      activeBlockEl = null;
      committed = false;
      scrollLocked = false;
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    }

    function onMove(e: TouchEvent) {
      if (!activeBlockId || committed) return;

      if (document.body.classList.contains('notees-dragging-block')) {
        cleanup();
        return;
      }

      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);

      if (!scrollLocked && absDy > CANCEL_THRESHOLD && absDy > absDx) {
        cleanup();
        return;
      }

      if (!scrollLocked && absDx > LOCK_SCROLL_AFTER && absDx > absDy) {
        scrollLocked = true;
      }

      if (scrollLocked) {
        e.preventDefault();
      }

      const direction = dx >= 0 ? 'indent' : 'outdent';
      applyProgress(Math.min(absDx / THRESHOLD, 1), direction);

      if (absDx >= THRESHOLD) {
        committed = true;
        navigator.vibrate?.(25);
        if (dx > 0) {
          onIndent?.(activeBlockId);
        } else {
          onOutdent?.(activeBlockId);
        }
        cleanup();
      }
    }

    function onEnd() {
      cleanup();
    }

    function onStart(e: TouchEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest('.bullet-wrapper')) return;
      if (target.closest('.bullet-collapse-arrow')) return;

      const blockEl = target.closest<HTMLElement>('.node-block[data-block-id]');
      if (!blockEl) return;

      activeBlockId = blockEl.getAttribute('data-block-id');
      activeBlockEl = blockEl;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      committed = false;
      scrollLocked = false;

      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd, { passive: true });
      document.addEventListener('touchcancel', onEnd, { passive: true });
    }

    root.addEventListener('touchstart', onStart, { passive: true });

    return () => {
      root.removeEventListener('touchstart', onStart);
      cleanup();
    };
  }, [containerRef, onIndent, onOutdent, readOnly]);
}
