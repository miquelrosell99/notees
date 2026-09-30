/**
 * useViewportPosition — anchor a floating popup below its trigger with
 * viewport flip and edge clamping.
 *
 * Hand-rolled replacement for the legacy Floating-UI-based flip hook: the
 * popup is measured after mount, placed `bottom-start` relative to the
 * anchor, flipped above when there is no room below, and clamped inside the
 * viewport horizontally. Recomputes on scroll (any phase), viewport resize,
 * and element resize.
 *
 * Returns `null` until the first position is computed — consumers must render
 * the popup while open regardless (with `visibility: hidden` until
 * positioned) so it can be measured.
 */

import { useLayoutEffect, useState, type RefObject } from "react";

export interface ViewportPositionOptions {
  /** Ref to the popup element (required: the rendered popup is measured). */
  popupRef: RefObject<HTMLElement | null>;
  /** Gap between anchor and popup (default: 4) */
  gap?: number;
  /** Viewport edge clearance when clamping/flipping (default: 8) */
  edgePadding?: number;
}

export interface ViewportPosition {
  top: number;
  left: number;
}

export function useViewportPosition(
  anchorRef: RefObject<HTMLElement | null>,
  isOpen: boolean,
  options: ViewportPositionOptions,
): ViewportPosition | null {
  const { popupRef, gap = 4, edgePadding = 8 } = options;

  const [position, setPosition] = useState<ViewportPosition | null>(null);

  useLayoutEffect(() => {
    const reference = anchorRef.current;
    const floating = popupRef.current;
    if (!isOpen || !reference || !floating) {
      setPosition(null);
      return;
    }

    const update = () => {
      const anchorRect = reference.getBoundingClientRect();
      const popupRect = floating.getBoundingClientRect();

      let top = anchorRect.bottom + gap;
      // Flip above when there is no room below (and there IS room above).
      if (
        top + popupRect.height + edgePadding > window.innerHeight &&
        anchorRect.top - gap - popupRect.height > edgePadding
      ) {
        top = anchorRect.top - gap - popupRect.height;
      }

      let left = anchorRect.left;
      // Clamp horizontally inside the viewport.
      if (left + popupRect.width + edgePadding > window.innerWidth) {
        left = Math.max(edgePadding, window.innerWidth - popupRect.width - edgePadding);
      }
      left = Math.max(edgePadding, left);

      setPosition((prev) =>
        prev !== null && prev.top === top && prev.left === left ? prev : { top, left },
      );
    };

    update();

    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [isOpen, anchorRef, popupRef, gap, edgePadding]);

  return position;
}
