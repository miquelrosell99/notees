import { useLayoutEffect, useState, useCallback, type RefObject } from 'react';

export type PopupAlignment = 'left' | 'right';

export interface UsePopupPositionOptions {
  /** Horizontal alignment of the popup relative to the anchor (default: left). */
  alignment?: PopupAlignment;
  /** Vertical gap between anchor and popup in px (default: 8). */
  gap?: number;
  /** Minimum clearance from viewport edges in px (default: 8). */
  edgePadding?: number;
}

export interface PopupPosition {
  top: number;
  left: number;
}

/**
 * Positions a popup relative to an anchor element while keeping it inside the
 * viewport. The popup is anchored to the left or right edge of the anchor and
 * shifted inward when it would otherwise overflow the viewport.
 */
export function usePopupPosition(
  anchorRef: RefObject<HTMLElement | null>,
  popupRef: RefObject<HTMLElement | null>,
  isOpen: boolean,
  options: UsePopupPositionOptions = {},
): PopupPosition | null {
  const { alignment = 'left', gap = 8, edgePadding = 8 } = options;
  const [position, setPosition] = useState<PopupPosition | null>(null);

  const calculate = useCallback(() => {
    if (!isOpen || !anchorRef.current || !popupRef.current) {
      setPosition(null);
      return;
    }

    const anchorRect = anchorRef.current.getBoundingClientRect();
    const popupRect = popupRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;

    let left: number;
    if (alignment === 'right') {
      left = anchorRect.right - popupRect.width;
      if (left < edgePadding) {
        left = edgePadding;
      }
    } else {
      left = anchorRect.left;
      if (left + popupRect.width > viewportWidth - edgePadding) {
        left = viewportWidth - popupRect.width - edgePadding;
      }
      if (left < edgePadding) {
        left = edgePadding;
      }
    }

    const top = anchorRect.bottom + gap;

    setPosition({ top, left });
  }, [isOpen, alignment, gap, edgePadding, anchorRef, popupRef]);

  useLayoutEffect(() => {
    calculate();

    if (!isOpen) return;

    window.addEventListener('resize', calculate);
    return () => window.removeEventListener('resize', calculate);
  }, [calculate, isOpen]);

  return position;
}
