import { useLayoutEffect, useState, useCallback, type RefObject } from 'react';

export interface ViewportFlipOptions {
  /** Maximum height of the popup (default: 300) */
  maxHeight?: number;
  /** Gap between anchor and popup (default: 4) */
  gap?: number;
  /** Include width from anchor rect in the result */
  includeWidth?: boolean;
  /** Minimum width override (popup will be at least this wide) */
  minWidth?: number;
  /** Known popup width for horizontal clamping (omit to measure dynamically from popupRef) */
  popupWidth?: number;
  /** Ref to the popup element. When provided, its rendered width is measured and used for clamping. */
  popupRef?: RefObject<HTMLElement | null>;
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
 *
 * When `popupRef` is provided, the popup's rendered width is measured and used
 * to keep the popup inside the viewport by shifting it left when it overflows.
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
    popupRef,
    popupHeight,
    edgePadding = 16,
    fixed = false,
  } = options;

  const [position, setPosition] = useState<ViewportFlipResult | null>(null);

  const calculate = useCallback(() => {
    if (!isOpen || !anchorRef.current) {
      setPosition(null);
      return;
    }

    const rect = anchorRef.current.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const spaceBelow = viewportHeight - rect.bottom;
    const spaceAbove = rect.top;
    const scrollY = fixed ? 0 : window.scrollY;
    const scrollX = fixed ? 0 : window.scrollX;

    let top: number;
    let resultMaxHeight: number | undefined;

    if (popupHeight !== undefined) {
      // Fixed-size flip: known popup height, no dynamic maxHeight. Prefer the
      // popup's measured height over the estimate so the decision and clamp match
      // the real rendered size — an underestimate lets the popup overflow the
      // bottom of the viewport.
      const measuredHeight = popupRef?.current?.getBoundingClientRect().height;
      const effectivePopupHeight =
        measuredHeight && measuredHeight > 0 ? measuredHeight : popupHeight;
      const spaceBelow = viewportHeight - rect.bottom - gap - edgePadding;
      const spaceAbove = rect.top - gap - edgePadding;

      if (effectivePopupHeight <= spaceBelow) {
        // Fits below: keep the top edge adjacent to the caret.
        top = rect.bottom + gap;
      } else if (effectivePopupHeight <= spaceAbove) {
        // Fits above: keep the bottom edge adjacent to the caret.
        top = rect.top - gap - effectivePopupHeight;
      } else {
        // Does not fully fit on either side: choose the larger side so the popup
        // stays as close to the caret as possible.
        top = spaceBelow >= spaceAbove
          ? rect.bottom + gap
          : rect.top - gap - effectivePopupHeight;
      }
      // Always contain the popup within the viewport. This is the safety net for
      // an anchor that is itself off-screen (e.g. a stale caret read): without it,
      // flipping above/below an out-of-view anchor still overflows.
      const minTop = edgePadding;
      const maxTop = Math.max(edgePadding, viewportHeight - effectivePopupHeight - edgePadding);
      top = Math.max(minTop, Math.min(top, maxTop));
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

    // Horizontal clamping: prefer the rendered width, but fall back to the
    // provided width when the measurement is unavailable or zero (a zero
    // measurement would otherwise disable the max-right clamp and let the popup
    // overflow the right edge).
    const measuredWidth = popupRef?.current?.getBoundingClientRect().width;
    const effectivePopupWidth =
      measuredWidth && measuredWidth > 0 ? measuredWidth : popupWidth;
    if (effectivePopupWidth !== undefined) {
      if (left + effectivePopupWidth > viewportWidth - edgePadding) {
        left = viewportWidth - effectivePopupWidth - edgePadding;
      }
      if (left < edgePadding) {
        left = edgePadding;
      }
    }

    const result: ViewportFlipResult = { top, left };
    if (resultMaxHeight !== undefined) result.maxHeight = resultMaxHeight;
    if (includeWidth) {
      result.width = minWidth ? Math.max(rect.width, minWidth) : rect.width;
    }

    setPosition(result);
  }, [isOpen, anchorRef, maxPopupHeight, gap, popupHeight, edgePadding, fixed, popupRef, popupWidth, includeWidth, minWidth]);

  useLayoutEffect(() => {
    calculate();

    if (!isOpen) return;

    window.addEventListener('resize', calculate);
    return () => window.removeEventListener('resize', calculate);
  }, [calculate, isOpen]);

  return position;
}
