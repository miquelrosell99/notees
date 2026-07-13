/**
 * cursorOffsetFromPoint — Map a mouse click in the static content DOM to a
 * logical content offset that matches the inline editor's logical offset model.
 *
 * Logical offsets:
 * - text characters count as 1 each
 * - atomic inline nodes (links, date ranges, math, broken links, hard breaks)
 *   count as 1 each
 * - zero-width spaces and placeholder text are ignored
 */

const ATOMIC_CLASSES = new Set([
  'inline-link-wrapper',
  'inline-date-range-pill',
  'math-wrapper',
  'broken-link',
]);

function getCaretRange(clientX: number, clientY: number): Range | null {
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(clientX, clientY);
    if (pos) {
      const range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
      return range;
    }
  }

  if (document.caretRangeFromPoint) {
    return document.caretRangeFromPoint(clientX, clientY);
  }

  return null;
}

function isAtomicElement(node: Node): node is Element {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as Element;
  if (el.tagName === 'BR') return true;
  for (const cls of el.classList) {
    if (ATOMIC_CLASSES.has(cls)) return true;
  }
  return false;
}

function getNodeLogicalSize(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent?.length ?? 0;
  }

  if (!isAtomicElement(node)) {
    let size = 0;
    for (const child of node.childNodes) {
      size += getNodeLogicalSize(child);
    }
    return size;
  }

  return 1;
}

function getNodeLogicalOffset(root: Node, targetNode: Node): number {
  let offset = 0;

  function walk(node: Node): boolean {
    if (node === targetNode) return true;

    if (node.contains(targetNode)) {
      for (const child of node.childNodes) {
        if (walk(child)) return true;
      }
      return true;
    }

    offset += getNodeLogicalSize(node);
    return false;
  }

  walk(root);
  return offset;
}

function findAtomicAncestor(node: Node, root: Node): Element | null {
  let current: Node | null = node;
  while (current && current !== root) {
    if (isAtomicElement(current)) return current as Element;
    current = current.parentNode;
  }
  return null;
}

/**
 * Returns the logical content offset for the caret at (clientX, clientY)
 * inside `root`, or `null` if the point is outside the root.
 */
export function getLogicalOffsetFromPoint(
  root: HTMLElement,
  clientX: number,
  clientY: number,
): number | null {
  const range = getCaretRange(clientX, clientY);
  if (!range) return null;

  const offsetNode = range.startContainer;
  const offsetInNode = range.startOffset;

  if (!root.contains(offsetNode)) return null;

  if (offsetNode === root) {
    let offset = 0;
    for (let i = 0; i < Math.min(offsetInNode, root.childNodes.length); i++) {
      offset += getNodeLogicalSize(root.childNodes[i]);
    }
    return offset;
  }

  const atomicAncestor = findAtomicAncestor(offsetNode, root);
  if (atomicAncestor) {
    const rect = atomicAncestor.getBoundingClientRect();
    const placeBefore = clientX < rect.left + rect.width / 2;
    const nodeOffset = getNodeLogicalOffset(root, atomicAncestor);
    return placeBefore ? nodeOffset : nodeOffset + 1;
  }

  let offset = 0;

  function walk(node: Node): boolean {
    if (node === offsetNode) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? '';
        offset += Math.min(offsetInNode, text.length);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        for (let i = 0; i < Math.min(offsetInNode, node.childNodes.length); i++) {
          offset += getNodeLogicalSize(node.childNodes[i]);
        }
      }
      return true;
    }

    if (node.contains(offsetNode)) {
      for (const child of node.childNodes) {
        if (walk(child)) return true;
      }
      return true;
    }

    offset += getNodeLogicalSize(node);
    return false;
  }

  for (const child of root.childNodes) {
    if (walk(child)) return offset;
  }

  return null;
}
