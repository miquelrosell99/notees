/**
 * Pure decision logic for the Modal bottom-sheet swipe-to-dismiss gesture.
 * Kept separate from Modal.tsx so the thresholds are unit-testable without a DOM.
 */

/** Downward travel (px) required before the dismiss-drag engages. */
export const SHEET_DRAG_SLOP_PX = 8;
/** Drag distance (px) that always dismisses the sheet on release. */
export const SHEET_DISMISS_MIN_DISTANCE_PX = 120;
/** Fraction of the sheet height that dismisses the sheet on release. */
export const SHEET_DISMISS_HEIGHT_RATIO = 0.35;
/** Downward velocity (px/ms) that dismisses even below the distance threshold. */
export const SHEET_DISMISS_VELOCITY = 0.5;

/** Where on the sheet the gesture started. */
export type SheetDragRegion = 'chrome' | 'content';

/**
 * Decide whether a touch move engages the sheet dismiss-drag.
 * - Gestures starting on the drag handle / header (`chrome`) always engage.
 * - Gestures starting inside the scrollable content (`content`) only engage
 *   while the content is scrolled to the top — otherwise the move belongs to
 *   normal scrolling.
 * Only downward moves beyond the slop engage; upward moves never do.
 */
export function shouldEngageSheetDrag(
  region: SheetDragRegion,
  contentScrollTop: number,
  dy: number
): boolean {
  if (dy <= SHEET_DRAG_SLOP_PX) return false;
  if (region === 'chrome') return true;
  return contentScrollTop === 0;
}

/**
 * Decide whether the sheet should dismiss on release: dragged far enough
 * (absolute floor or fraction of the sheet height) or flicked downward fast
 * enough.
 */
export function shouldDismissSheet(offset: number, velocity: number, sheetHeight: number): boolean {
  return (
    offset > Math.max(SHEET_DISMISS_MIN_DISTANCE_PX, sheetHeight * SHEET_DISMISS_HEIGHT_RATIO) ||
    velocity > SHEET_DISMISS_VELOCITY
  );
}
