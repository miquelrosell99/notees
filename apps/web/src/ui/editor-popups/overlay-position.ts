/**
 * overlay-position — the manual placement math for the ported floating editor
 * chrome (FloatingToolbar, TriggerPopup).
 *
 * Replaces the archived components' Floating UI dependency (not shipped in
 * this app shell) with the same decisions: anchor to a viewport-space rect,
 * prefer below with a gap, flip above when there is no room, and clamp
 * horizontally into the viewport. All inputs/outputs are viewport
 * coordinates — the popups are position: fixed.
 */

export interface OverlayAnchorRect {
  /** Top edge of the anchor line (selection/caret top). */
  top: number;
  /** Bottom edge of the anchor line (selection/caret bottom). */
  bottom: number;
  /** Left edge of the anchor line. */
  left: number;
}

/**
 * Vertical placement for a floating surface of `floatingHeight`: below the
 * anchor with `gap` when it fits, flipped above the anchor otherwise (as long
 * as there is room above; when neither fits, below wins and the viewport
 * scrolls). Returns the CSS `top` and which side the surface landed on.
 */
export function flipOverlayTop(
  anchor: OverlayAnchorRect,
  floatingHeight: number,
  gap = 8,
  padding = 8,
): { top: number; placement: "above" | "below" } {
  const viewportHeight = typeof window === "undefined" ? 0 : window.innerHeight;
  const belowTop = anchor.bottom + gap;
  const fitsBelow = belowTop + floatingHeight <= viewportHeight - padding;
  if (fitsBelow) return { top: belowTop, placement: "below" };
  const aboveTop = anchor.top - gap - floatingHeight;
  if (aboveTop >= padding) return { top: aboveTop, placement: "above" };
  return { top: Math.max(padding, belowTop), placement: "below" };
}

/**
 * Horizontal `left` clamped so a surface of `floatingWidth` starting at
 * `anchorLeft` stays inside the viewport with `padding` on both sides.
 */
export function clampOverlayLeft(anchorLeft: number, floatingWidth: number, padding = 8): number {
  const viewportWidth = typeof window === "undefined" ? 0 : window.innerWidth;
  const maxLeft = Math.max(padding, viewportWidth - floatingWidth - padding);
  return Math.min(Math.max(anchorLeft, padding), maxLeft);
}

/**
 * Anchor rect of a DOM Range in viewport coordinates. Platforms without
 * Range rect support (jsdom) anchor at the viewport origin — harmless for
 * the fixed-position popups and their tests.
 */
export function rangeAnchorRect(range: Range | null): OverlayAnchorRect {
  try {
    if (range !== null && typeof range.getBoundingClientRect === "function") {
      const rect = range.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, left: rect.left };
    }
  } catch {
    // fall through to the zero anchor
  }
  return { top: 0, bottom: 0, left: 0 };
}
