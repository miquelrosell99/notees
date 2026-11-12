/**
 * useAnchoredPopup — the shared placement pass for the portaled floating
 * editor chrome (TriggerPopup, TemplateListPopup, IconPickerPopup,
 * FloatingToolbar): anchor to a viewport-space rect, flip above when there
 * is no room below, clamp horizontally into the viewport, and recompute on
 * window resize and document scroll (capture — the anchor may live in a
 * scrolling container).
 *
 * top/left are written imperatively on the popup element so repositioning
 * never goes through React renders. What a popup needs back (placement
 * state, the visibility flip) rides the callbacks; a null `getAnchorRect`
 * skips positioning and fires only `onAnchorUnavailable`, so a popup may
 * reveal itself unpositioned instead of staying hidden.
 */

import { useLayoutEffect, useRef, type RefObject } from "react";

import {
  clampOverlayLeft,
  flipOverlayTop,
  type OverlayAnchorRect,
} from "../../../ui/editor-popups/overlay-position.js";

export type AnchoredPopupPlacement = "above" | "below";

export interface UseAnchoredPopupOptions {
  /** The floating element; its offset size is measured per compute. */
  popupRef: RefObject<HTMLElement | null>;
  /**
   * The anchor rect per compute — re-read on every scroll/resize pass (a
   * live Range rect, a tracked anchor element). Return null when the anchor
   * is gone; `onAnchorUnavailable` fires instead of positioning.
   */
  getAnchorRect: () => OverlayAnchorRect | null;
  /** Inputs whose change re-anchors the pass (the position prop, the anchor element). */
  deps?: readonly unknown[];
  /** Whether the placement pass runs (default true). */
  enabled?: boolean;
  /** Gap between the anchor line and the popup (default 4). */
  gap?: number;
  /** Viewport clearance for the flip/clamp (default 8). */
  padding?: number;
  /** Fires after each compute with the resolved placement. */
  onPlaced?: ((placement: AnchoredPopupPlacement) => void) | undefined;
  /** Fires when `getAnchorRect()` returned null — the anchor is gone. */
  onAnchorUnavailable?: (() => void) | undefined;
}

export function useAnchoredPopup(options: UseAnchoredPopupOptions): void {
  const {
    popupRef,
    getAnchorRect,
    deps = [],
    enabled = true,
    gap = 4,
    padding = 8,
    onPlaced,
    onAnchorUnavailable,
  } = options;

  const getAnchorRectRef = useRef(getAnchorRect);
  const onPlacedRef = useRef(onPlaced);
  const onAnchorUnavailableRef = useRef(onAnchorUnavailable);
  getAnchorRectRef.current = getAnchorRect;
  onPlacedRef.current = onPlaced;
  onAnchorUnavailableRef.current = onAnchorUnavailable;

  useLayoutEffect(() => {
    if (!enabled) return;
    const floating = popupRef.current;
    if (!floating) return;

    const update = () => {
      const anchor = getAnchorRectRef.current();
      if (anchor === null) {
        onAnchorUnavailableRef.current?.();
        return;
      }
      const { top, placement } = flipOverlayTop(anchor, floating.offsetHeight, gap, padding);
      floating.style.left = `${clampOverlayLeft(anchor.left, floating.offsetWidth, padding)}px`;
      floating.style.top = `${top}px`;
      onPlacedRef.current?.(placement);
    };

    update();
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps re-anchor the pass; the refs keep the callbacks fresh
  }, [popupRef, enabled, gap, padding, ...deps]);
}
