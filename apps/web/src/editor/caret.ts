/**
 * Caret helpers for the contentEditable block editor. All entry points are
 * defensive: jsdom (tests) has no layout engine, so every Range/Selection
 * operation is guarded and falls back to a plain focus().
 *
 * Offsets are PROSE offsets (see editor/selection.ts) — the block editor's
 * DOM interleaves atomic node-link pills with text nodes, so naive
 * child-index placement would land inside pills.
 */

import { placeCaret, selectionOffsets } from "@/editor/selection.js";

export type CaretPlacement = "start" | "end" | number;

/** Focus the element and place the caret (best effort; always focuses). */
export function focusWithCaret(element: HTMLElement, placement: CaretPlacement): void {
  const offset =
    placement === "start"
      ? 0
      : placement === "end"
        ? (element.textContent?.length ?? 0)
        : Math.max(0, Math.min(placement, element.textContent?.length ?? 0));
  placeCaret(element, offset);
}

/** Place the caret at the (x, y) point of the click that entered edit mode. */
export function focusAtPoint(element: HTMLElement, x: number, y: number): void {
  element.focus();
  try {
    const caret = document.caretRangeFromPoint?.(x, y);
    if (caret === undefined || caret === null) {
      focusWithCaret(element, "end");
      return;
    }
    const selection = window.getSelection();
    if (selection === null) return;
    selection.removeAllRanges();
    selection.addRange(caret);
    // A point inside an atomic pill must not leave the DOM caret there —
    // normalize through the prose mapping (boundary-only model).
    const mapped = selectionOffsets(element);
    if (mapped !== null) placeCaret(element, mapped.start);
    document.dispatchEvent(new Event("selectionchange"));
  } catch {
    focusWithCaret(element, "end");
  }
}
