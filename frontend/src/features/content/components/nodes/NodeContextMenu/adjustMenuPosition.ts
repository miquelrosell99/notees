/**
 * Adjusts a fixed-position element so it stays within the viewport.
 * Uses a callback ref to directly modify DOM style on mount — no state,
 * no re-render, guaranteed to run before the first paint.
 */
export function adjustMenuPosition(
  el: HTMLElement | null,
  position?: { x: number; y: number },
  anchorEl?: HTMLElement | null,
) {
  if (!el) return;
  const padding = 8;
  let x: number;
  let y: number;

  const anchorRect = anchorEl?.getBoundingClientRect();
  if (anchorRect) {
    x = anchorRect.left;
    y = anchorRect.bottom;
  } else if (position) {
    x = position.x;
    y = position.y;
  } else {
    return;
  }

  // Place at requested position first so we can measure true dimensions
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;

  const rect = el.getBoundingClientRect();

  // If menu overflows bottom, open upward from anchor/click point
  if (y + rect.height > window.innerHeight) {
    y = (anchorRect ? anchorRect.top : (position?.y ?? 0)) - rect.height;
  }
  // If menu overflows right
  if (x + rect.width > window.innerWidth) {
    x = window.innerWidth - rect.width - padding;
  }
  // Clamp to viewport edges
  if (x < padding) x = padding;
  if (y < padding) y = padding;

  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}
