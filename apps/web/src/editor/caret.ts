/**
 * Caret helpers for the contentEditable block editor. All entry points are
 * defensive: jsdom (tests) has no layout engine, so every Range/Selection
 * operation is guarded and falls back to a plain focus().
 */

export type CaretPlacement = "start" | "end" | number;

/** Focus the element and place the caret (best effort; always focuses). */
export function focusWithCaret(element: HTMLElement, placement: CaretPlacement): void {
  element.focus();
  try {
    const selection = window.getSelection();
    if (selection === null) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    const offset =
      typeof placement === "number"
        ? Math.max(0, Math.min(placement, element.textContent?.length ?? 0))
        : placement === "start"
          ? 0
          : element.textContent?.length ?? 0;
    range.setStart(range.startContainer, Math.min(offset, range.endOffset));
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    // jsdom / edge layouts: focus() alone is enough for the tests.
  }
}

/** Place the caret at the (x, y) point of the click that entered edit mode. */
export function focusAtPoint(element: HTMLElement, x: number, y: number): void {
  element.focus();
  try {
    const caret = document.caretRangeFromPoint?.(x, y);
    if (caret === undefined || caret === null) return;
    const selection = window.getSelection();
    if (selection === null) return;
    selection.removeAllRanges();
    selection.addRange(caret);
  } catch {
    focusWithCaret(element, "end");
  }
}
