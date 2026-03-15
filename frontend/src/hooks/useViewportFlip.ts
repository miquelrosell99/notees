import { useEffect, useState, type RefObject } from 'react';

export interface ViewportFlipOptions {
  /** Maximum height of the popup (default: 300) */
  maxHeight?: number;
  /** Gap between anchor and popup (default: 4) */
  gap?: number;
  /** Include width from anchor rect in the result */
  includeWidth?: boolean;
  /** Minimum width override (popup will be at least this wide) */
  minWidth?: number;
  /** Known popup width for horizontal clamping (omit to skip horizontal clamping) */
  popupWidth?: number;
  /** Known popup height for simple flip (omit to use dynamic maxHeight calculation) */
  popupHeight?: number;
  /** Horizontal edge padding when clamping (default: 16) */
  edgePadding?: number;
  /** Use fixed positioning (no scroll offsets). Default: false (absolute positioning) */
  fixed?: boolean;
}

export interface ViewportFlipResult {
  top: number;
  left: number;
  maxHeight?: number;
  width?: number;
}

/**
 * Calculates popup position relative to an anchor element, flipping
 * above when there isn't enough space below.
 *
 * Supports two modes:
 * - **Dynamic** (default): computes `maxHeight` based on available viewport space.
 *   Used by Dropdown and NodeSelector.
 * - **Fixed-size**: when `popupHeight` is provided, does a simple flip without
 *   dynamic maxHeight. Used by CalendarPopup.
 */
export function useViewportFlip(
  anchorRef: RefObject<HTMLElement | null>,
  isOpen: boolean,
  options: ViewportFlipOptions = {},
): ViewportFlipResult | null {
  const {
    maxHeight: maxPopupHeight = 300,
    gap = 4,
    includeWidth = false,
    minWidth,
    popupWidth,
    popupHeight,
    edgePadding = 16,
    fixed = false,
  } = options;

  const [position, setPosition] = useState<ViewportFlipResult | null>(null);

  useEffect(() => {
    if (!isOpen || !anchorRef.current) {
      setPosition(null);
      return;
    }

    const rect = anchorRef.current.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const spaceBelow = viewportHeight - rect.bottom;
    const spaceAbove = rect.top;
    const scrollY = fixed ? 0 : window.scrollY;
    const scrollX = fixed ? 0 : window.scrollX;

    let top: number;
    let resultMaxHeight: number | undefined;

    if (popupHeight !== undefined) {
      // Simple flip: known popup height, no dynamic maxHeight
      top = rect.bottom + gap;
      if (top + popupHeight > viewportHeight - edgePadding) {
        top = rect.top - popupHeight - gap;
      }
      // Clamp so popup never goes above the viewport
      if (top < edgePadding) {
        top = edgePadding;
      }
      top += scrollY;
    } else {
      // Dynamic flip: compute maxHeight based on available space
      let maxHeight: number;
      if (spaceBelow >= maxPopupHeight || spaceBelow > spaceAbove) {
        top = rect.bottom + scrollY + gap;
        maxHeight = Math.min(maxPopupHeight, spaceBelow - gap * 2);
      } else {
        maxHeight = Math.min(maxPopupHeight, spaceAbove - gap * 2);
        top = rect.top + scrollY - maxHeight - gap;
      }
      resultMaxHeight = maxHeight;
    }

    let left = rect.left + scrollX;

    // Horizontal clamping
    if (popupWidth !== undefined) {
      const viewportWidth = window.innerWidth;
      if (left + popupWidth > viewportWidth - edgePadding) {
        left = viewportWidth - popupWidth - edgePadding;
      }
    }

    const result: ViewportFlipResult = { top, left };
    if (resultMaxHeight !== undefined) result.maxHeight = resultMaxHeight;
    if (includeWidth) {
      result.width = minWidth ? Math.max(rect.width, minWidth) : rect.width;
    }

    setPosition(result);
  }, [isOpen, maxPopupHeight, gap, includeWidth, minWidth, popupWidth, popupHeight, edgePadding, fixed, anchorRef]);

  return position;
}
