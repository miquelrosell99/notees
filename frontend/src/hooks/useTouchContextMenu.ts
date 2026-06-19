/**
 * useTouchContextMenu
 *
 * Adds global touch handlers that turn a long-press into a synthetic
 * `contextmenu` event. This lets the existing right-click context menus work
 * on Android / touch devices without changing every call site.
 *
 * Behaviours:
 *   - Hold finger still for ~600 ms to trigger the context menu.
 *   - Movement beyond a small threshold cancels the hold.
 *   - The synthetic event carries the original touch coordinates so menus
 *     open where the finger was.
 *   - The next click on the same target is suppressed to avoid accidentally
 *     activating the underlying control after the menu opens.
 */
import { useEffect, useRef } from 'react';

const LONG_PRESS_MS = 600;
const MOVE_THRESHOLD_PX = 10;
const CLICK_SUPPRESS_MS = 500;

export function isEditableElement(el: Element): boolean {
  if (el instanceof HTMLElement) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true;
    if (el.isContentEditable) return true;
    if (el.closest('.inline-editor')) return true;
  }
  return false;
}

export function useTouchContextMenu(enabled: boolean) {
  const stateRef = useRef({
    timer: null as number | null,
    startX: 0,
    startY: 0,
    target: null as Element | null,
    suppressClickTarget: null as Element | null,
    suppressClickTimeout: null as number | null,
  });

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    const state = stateRef.current;

    const clearTimer = () => {
      if (state.timer) {
        window.clearTimeout(state.timer);
        state.timer = null;
      }
      state.target = null;
    };

    const clearClickSuppress = () => {
      if (state.suppressClickTimeout) {
        window.clearTimeout(state.suppressClickTimeout);
        state.suppressClickTimeout = null;
      }
      state.suppressClickTarget = null;
    };

    const onTouchStart = (e: TouchEvent) => {
      clearTimer();
      clearClickSuppress();

      const touch = e.touches[0];
      if (!touch) return;

      const target = e.target as Element | null;
      if (!target || isEditableElement(target)) return;

      state.startX = touch.clientX;
      state.startY = touch.clientY;
      state.target = target;

      state.timer = window.setTimeout(() => {
        if (!state.target) return;

        const event = new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: state.startX,
          clientY: state.startY,
          screenX: state.startX,
          screenY: state.startY,
          button: 2,
          buttons: 2,
        });
        state.target.dispatchEvent(event);

        // Suppress the click that usually follows a touch release so we don't
        // accidentally activate the underlying button/link.
        state.suppressClickTarget = state.target;
        state.suppressClickTimeout = window.setTimeout(clearClickSuppress, CLICK_SUPPRESS_MS);

        state.timer = null;
        state.target = null;
      }, LONG_PRESS_MS);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!state.timer) return;
      const touch = e.touches[0];
      if (!touch) return;
      const dx = touch.clientX - state.startX;
      const dy = touch.clientY - state.startY;
      if (Math.hypot(dx, dy) > MOVE_THRESHOLD_PX) {
        clearTimer();
      }
    };

    const onTouchEnd = () => clearTimer();
    const onTouchCancel = () => clearTimer();

    const onClick = (e: MouseEvent) => {
      if (!state.suppressClickTarget) return;
      const target = e.target as Element | null;
      if (
        target &&
        (target === state.suppressClickTarget || state.suppressClickTarget.contains(target))
      ) {
        e.preventDefault();
        e.stopPropagation();
      }
      clearClickSuppress();
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    document.addEventListener('touchcancel', onTouchCancel, { passive: true });
    document.addEventListener('click', onClick, true);

    return () => {
      clearTimer();
      clearClickSuppress();
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchCancel);
      document.removeEventListener('click', onClick, true);
    };
  }, [enabled]);
}
