/**
 * Selection/caret helpers shared by the contentEditable surfaces
 * (BlockTextEditor — body blocks and the page title row).
 *
 * The block editor's DOM is a flat run of text nodes interleaved with
 * atomic node-link pills (`editor/editable-dom.ts` — contenteditable="false"
 * spans). Every offset here is a PROSE offset (summed text lengths, pills
 * contributing their captured text), not a DOM offset. Positions inside a
 * pill map to the pill's start — the boundary-only model: user selections
 * and carets can never start inside a
 * contenteditable="false" element, so prose endpoints are always boundaries.
 */

import { ATOM_CLASS } from "@/editor/editable-dom.js";

/** True when `node` is an atomic pill element (or sits inside one). */
function isAtomElement(node: Node): boolean {
  return node instanceof HTMLElement && node.classList.contains(ATOM_CLASS);
}

/**
 * Prose offset of a DOM position inside the editor. The editable DOM is a
 * flat run of text nodes and pill elements, so the offset is the summed
 * text lengths of the preceding siblings plus the in-node offset. A
 * position inside a pill maps to the pill's prose start (boundary model).
 * Null when the position is not inside the editor.
 */
function domOffsetToProse(el: HTMLElement, node: Node, offset: number): number | null {
  if (node === el) {
    // A child-index position (the selection API collapses to (el, index)
    // at element edges): the prose offset is the summed text of the
    // first `offset` children.
    let total = 0;
    let n = el.firstChild;
    for (let i = 0; i < offset && n !== null; i += 1, n = n.nextSibling) {
      total += n.textContent?.length ?? 0;
    }
    return total;
  }
  // Walk up to the direct child of `el` that contains `node`.
  let child: Node | null = node;
  while (child !== null && child.parentNode !== el) child = child.parentNode;
  if (child === null) return null;
  let total = 0;
  for (let n = el.firstChild; n !== null && n !== child; n = n.nextSibling) {
    total += n.textContent?.length ?? 0;
  }
  if (isAtomElement(child)) {
    // Boundary-only model: strictly-inside positions map to the pill's
    // start; a position at the END of the pill's content maps to the pill's
    // end (the caret legitimately sits there — after the unit).
    const len = child.textContent?.length ?? 0;
    const text = child.firstChild;
    const atEnd =
      node === child ? text === null || offset >= 1
      : node === text ? offset >= len
      : false;
    return total + (atEnd ? len : 0);
  }
  return total + offset;
}

/**
 * Inverse mapping: the DOM position for a prose offset (a text node + inner
 * offset, or an element-edge position between children). Atom-internal
 * offsets clamp to the nearest boundary — callers only ever pass boundaries.
 */
function proseToDom(
  el: HTMLElement,
  offset: number,
): { node: Node; offset: number } | null {
  let acc = 0;
  for (let n = el.firstChild; n !== null; n = n.nextSibling) {
    const len = n.textContent?.length ?? 0;
    if (acc + len >= offset || n.nextSibling === null) {
      if (n instanceof Text) {
        return { node: n, offset: Math.max(0, Math.min(offset - acc, len)) };
      }
      // Pill element: at/inside its start → before it; otherwise after it.
      let index = 0;
      for (let m = el.firstChild; m !== null && m !== n; m = m.nextSibling) index += 1;
      return { node: el, offset: offset <= acc ? index : index + 1 };
    }
    acc += len;
  }
  return null; // empty element
}

/** Current selection as prose offsets within the editor; null when collapsed/foreign. */
export function selectionOffsets(el: HTMLElement): { start: number; end: number } | null {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null;
  const start = domOffsetToProse(el, range.startContainer, range.startOffset);
  const end = domOffsetToProse(el, range.endContainer, range.endOffset);
  if (start === null || end === null) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

/** Collapsed-caret prose offset within the editor (null when the selection is a range/foreign). */
export function caretOffset(el: HTMLElement): number | null {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!range.collapsed) return null;
  if (!el.contains(range.startContainer)) return null;
  return domOffsetToProse(el, range.startContainer, range.startOffset);
}

/** Collapse the caret to a prose offset. */
export function placeCaret(el: HTMLElement, offset: number): void {
  el.focus();
  try {
    const selection = window.getSelection();
    if (selection === null) return;
    const range = document.createRange();
    const target = proseToDom(el, offset);
    if (target !== null) {
      range.setStart(target.node, target.offset);
    } else {
      range.selectNodeContents(el);
    }
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  } catch {
    // jsdom / edge layouts: focus() alone is enough.
  }
}

/** Select the prose range [start, end) inside the editor (the @-over-selection cancel path). */
export function selectRange(el: HTMLElement, start: number, end: number): void {
  el.focus();
  try {
    const selection = window.getSelection();
    if (selection === null) return;
    const range = document.createRange();
    const startTarget = proseToDom(el, start);
    const endTarget = proseToDom(el, end);
    if (startTarget !== null && endTarget !== null) {
      range.setStart(startTarget.node, startTarget.offset);
      range.setEnd(endTarget.node, endTarget.offset);
    } else {
      range.selectNodeContents(el);
    }
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  } catch {
    // jsdom / edge layouts: focus() alone is enough.
  }
}

/**
 * Prose offset at a viewport point inside the editor — the right-click hit
 * test for the node-link context menu (the selection API cannot answer "what
 * sits under this point").
 */
export function proseOffsetFromPoint(el: HTMLElement, x: number, y: number): number | null {
  try {
    let node: Node | null = null;
    let offset = 0;
    const doc = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    const range = doc.caretRangeFromPoint?.(x, y);
    if (range !== undefined && range !== null) {
      node = range.startContainer;
      offset = range.startOffset;
    } else {
      const position = doc.caretPositionFromPoint?.(x, y);
      if (position === undefined || position === null) return null;
      node = position.offsetNode;
      offset = position.offset;
    }
    if (node === null || !el.contains(node)) return null;
    return domOffsetToProse(el, node, offset);
  } catch {
    return null;
  }
}
