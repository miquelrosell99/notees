import { describe, it, expect } from 'vitest';
import {
  shouldEngageSheetDrag,
  shouldDismissSheet,
  SHEET_DRAG_SLOP_PX,
  SHEET_DISMISS_MIN_DISTANCE_PX,
  SHEET_DISMISS_HEIGHT_RATIO,
  SHEET_DISMISS_VELOCITY,
} from './sheetGesture';

describe('shouldEngageSheetDrag', () => {
  it('engages for the chrome region once past the slop', () => {
    expect(shouldEngageSheetDrag('chrome', 0, SHEET_DRAG_SLOP_PX + 1)).toBe(true);
  });

  it('ignores moves at or below the slop', () => {
    expect(shouldEngageSheetDrag('chrome', 0, SHEET_DRAG_SLOP_PX)).toBe(false);
    expect(shouldEngageSheetDrag('chrome', 0, 0)).toBe(false);
  });

  it('never engages for upward moves', () => {
    expect(shouldEngageSheetDrag('chrome', 0, -20)).toBe(false);
    expect(shouldEngageSheetDrag('content', 0, -20)).toBe(false);
  });

  it('engages for content only when scrolled to the top', () => {
    expect(shouldEngageSheetDrag('content', 0, SHEET_DRAG_SLOP_PX + 1)).toBe(true);
    expect(shouldEngageSheetDrag('content', 1, SHEET_DRAG_SLOP_PX + 1)).toBe(false);
    expect(shouldEngageSheetDrag('content', 200, 80)).toBe(false);
  });
});

describe('shouldDismissSheet', () => {
  it('dismisses past the absolute distance floor', () => {
    // Short sheet: 35% of height < 120px, so the floor is the threshold.
    expect(shouldDismissSheet(SHEET_DISMISS_MIN_DISTANCE_PX + 1, 0, 200)).toBe(true);
    expect(shouldDismissSheet(SHEET_DISMISS_MIN_DISTANCE_PX, 0, 200)).toBe(false);
  });

  it('dismisses past the sheet-height ratio on tall sheets', () => {
    const sheetHeight = 1000;
    expect(shouldDismissSheet(sheetHeight * SHEET_DISMISS_HEIGHT_RATIO + 1, 0, sheetHeight)).toBe(true);
    expect(shouldDismissSheet(sheetHeight * SHEET_DISMISS_HEIGHT_RATIO, 0, sheetHeight)).toBe(false);
  });

  it('uses the larger of the two distance thresholds', () => {
    // Tall sheet: 35% of height > 120px floor, so the ratio wins.
    expect(shouldDismissSheet(200, 0, 1000)).toBe(false);
    expect(shouldDismissSheet(351, 0, 1000)).toBe(true);
  });

  it('dismisses on a fast downward flick regardless of distance', () => {
    expect(shouldDismissSheet(10, SHEET_DISMISS_VELOCITY + 0.1, 800)).toBe(true);
  });

  it('snaps back below both thresholds', () => {
    expect(shouldDismissSheet(10, SHEET_DISMISS_VELOCITY, 800)).toBe(false);
    expect(shouldDismissSheet(0, 0, 800)).toBe(false);
  });
});
