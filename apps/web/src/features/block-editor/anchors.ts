/**
 * Viewport anchors for the block editor's toolbar and popups — the
 * current selection's client rect read at popup-open time (position:
 * fixed targets). `selectionAnchor` centers on the selection end (the
 * verb popover); `caretLineAnchor` anchors below the caret line with
 * the caret top for flip/clamp positioning (the slash and template
 * popups). jsdom and edge layouts yield zero rects — the popups land
 * at the viewport origin, which is harmless. Extracted verbatim from
 * BlockTextEditor.tsx (Stage D monolith split).
 */

/** Viewport anchor for the toolbar/popups (jsdom rects are zero — harmless). */
export function selectionAnchor(): { top: number; left: number } {
  try {
    const selection = window.getSelection();
    if (selection !== null && selection.rangeCount > 0) {
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      return { top: rect.top, left: rect.left + rect.width / 2 };
    }
  } catch {
    // jsdom / edge layouts: the popup lands at the viewport origin.
  }
  return { top: 0, left: 0 };
}

/**
 * Viewport anchor for the slash popup: `top` = caret bottom, `caretTop` =
 * caret top (the popup is position: fixed). Same zero-rect jsdom fallback.
 */
export function caretLineAnchor(): { top: number; left: number; caretTop: number } {
  try {
    const selection = window.getSelection();
    if (selection !== null && selection.rangeCount > 0) {
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      return { top: rect.bottom, left: rect.left, caretTop: rect.top };
    }
  } catch {
    // jsdom / edge layouts: the popup lands at the viewport origin.
  }
  return { top: 0, left: 0, caretTop: 0 };
}
