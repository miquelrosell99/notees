import { useLayoutEffect, useState, type RefObject } from 'react';
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom';

export interface ViewportFlipOptions {
  /** Maximum height of the popup (default: 300) */
  maxHeight?: number;
  /** Gap between anchor and popup (default: 4) */
  gap?: number;
  /** Include width from anchor rect in the result */
  includeWidth?: boolean;
  /** Minimum width override (popup will be at least this wide) */
  minWidth?: number;
  /**
   * Ref to the popup element. Required: Floating UI measures the rendered
   * popup for exact flip/shift decisions, and `autoUpdate` observes it for
   * resize-driven repositioning.
   */
  popupRef: RefObject<HTMLElement | null>;
  /**
   * Fixed-size mode: when set, skip the dynamic `maxHeight` computation and
   * just flip the popup as-is. The value itself is ignored — the rendered
   * popup is always measured.
   */
  popupHeight?: number;
  /** Horizontal/vertical edge padding when clamping (default: 16) */
  edgePadding?: number;
  /** Use fixed positioning (default: absolute) */
  fixed?: boolean;
}

export interface ViewportFlipResult {
  top: number;
  left: number;
  maxHeight?: number;
  width?: number;
}

/**
 * Positions a popup relative to an anchor element using Floating UI, flipping
 * above when there isn't enough space below and keeping it inside the viewport.
 *
 * Returns `null` until the first position is computed — consumers must render
 * the popup while open regardless (with `visibility: hidden` until positioned)
 * so Floating UI can measure it.
 *
 * Two modes:
 * - **Dynamic** (default): returns a `maxHeight` based on available viewport
 *   space. Used by Dropdown and NodeSelector.
 * - **Fixed-size**: when `popupHeight` is provided, does a simple flip without
 *   a dynamic maxHeight. Used by CalendarPopup and DatePickerPopup.
 *
 * Positioning is tracked with `autoUpdate`: the popup re-anchors on scroll
 * (any ancestor), viewport resize, element resize, and layout shifts. Updates
 * go through React state here (unlike ButtonWithPanel's imperative writes) —
 * acceptable because these popups are lightweight lists.
 */
export function useViewportFlip(
  anchorRef: RefObject<HTMLElement | null>,
  isOpen: boolean,
  options: ViewportFlipOptions,
): ViewportFlipResult | null {
  const {
    maxHeight: maxPopupHeight = 300,
    gap = 4,
    includeWidth = false,
    minWidth,
    popupRef,
    popupHeight,
    edgePadding = 16,
    fixed = false,
  } = options;

  const [position, setPosition] = useState<ViewportFlipResult | null>(null);

  useLayoutEffect(() => {
    const reference = anchorRef.current;
    const floating = popupRef?.current;
    if (!isOpen || !reference || !floating) {
      setPosition(null);
      return;
    }

    const update = () => {
      let computedMaxHeight: number | undefined;

      computePosition(reference, floating, {
        placement: 'bottom-start',
        strategy: fixed ? 'fixed' : 'absolute',
        middleware: [
          offset(gap),
          flip({ padding: edgePadding, fallbackPlacements: ['top-start'] }),
          // Fixed-size mode skips the dynamic maxHeight (old `popupHeight` behavior).
          ...(popupHeight === undefined
            ? [
                size({
                  padding: edgePadding,
                  apply({ availableHeight }) {
                    computedMaxHeight = Math.min(
                      maxPopupHeight,
                      Math.max(0, availableHeight - gap),
                    );
                  },
                }),
              ]
            : []),
          shift({ padding: edgePadding, crossAxis: true }),
        ],
      }).then(({ x, y }) => {
        const result: ViewportFlipResult = { top: y, left: x };
        if (computedMaxHeight !== undefined) result.maxHeight = computedMaxHeight;
        if (includeWidth) {
          const anchorWidth = reference.getBoundingClientRect().width;
          result.width = minWidth ? Math.max(anchorWidth, minWidth) : anchorWidth;
        }
        setPosition((prev) =>
          prev &&
          prev.top === result.top &&
          prev.left === result.left &&
          prev.maxHeight === result.maxHeight &&
          prev.width === result.width
            ? prev
            : result,
        );
      });
    };

    update();
    return autoUpdate(reference, floating, update);
  }, [isOpen, anchorRef, popupRef, maxPopupHeight, gap, includeWidth, minWidth, popupHeight, edgePadding, fixed]);

  return position;
}
