/**
 * TouchIndentPlugin — horizontal swipe on a bullet to indent / outdent on touch screens.
 *
 * Gesture:
 *   • Touch starts on .bullet-wrapper (not the collapse arrow).
 *   • Swipe right ≥ THRESHOLD px → indent   (make child of previous sibling)
 *   • Swipe left  ≥ THRESHOLD px → outdent  (move up to grandparent level)
 *   • Vertical movement > CANCEL_THRESHOLD cancels the gesture (user is scrolling).
 *
 * Visual feedback:
 *   • The bullet wrapper shifts in the swipe direction via CSS transform.
 *   • Bullet dot brightens as progress approaches the threshold.
 *   • Haptic vibration fires on commit (if supported).
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';

export interface TouchIndentPluginProps {
  onIndent?: (blockId: string) => void;
  onOutdent?: (blockId: string) => void;
  readOnly?: boolean;
}

/** Horizontal distance (px) required to trigger indent/outdent */
const THRESHOLD = 52;
/** Max vertical drift (px) before we decide the user is scrolling */
const CANCEL_THRESHOLD = 22;
/** Horizontal drift (px) before we start suppressing scroll */
const LOCK_SCROLL_AFTER = 14;

export function TouchIndentPlugin({ onIndent, onOutdent, readOnly }: TouchIndentPluginProps): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (readOnly) return;

    const root = editor.getRootElement();
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

      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);

      // Cancel if vertical intent detected before we locked scroll
      if (!scrollLocked && absDy > CANCEL_THRESHOLD && absDy > absDx) {
        cleanup();
        return;
      }

      // Once horizontal intent is clear, lock scroll
      if (!scrollLocked && absDx > LOCK_SCROLL_AFTER && absDx > absDy) {
        scrollLocked = true;
      }

      if (scrollLocked) {
        e.preventDefault(); // suppress page scroll during confirmed horizontal swipe
      }

      // Update animated progress
      const direction = dx >= 0 ? 'indent' : 'outdent';
      applyProgress(Math.min(absDx / THRESHOLD, 1), direction);

      // Commit when threshold is crossed
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

      // Only handle touches that start on the bullet (not the collapse arrow)
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

      // Attach move/end to document so they fire even if pointer leaves the element
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd, { passive: true });
      document.addEventListener('touchcancel', onEnd, { passive: true });
    }

    root.addEventListener('touchstart', onStart, { passive: true });

    return () => {
      root.removeEventListener('touchstart', onStart);
      cleanup();
    };
  }, [editor, onIndent, onOutdent, readOnly]);

  return null;
}
