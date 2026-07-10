/**
 * selectionSync — Map between logical AST offsets and the browser DOM selection.
 *
 * The custom editor renders each inline unit as a direct child of the
 * contentEditable root: text units become a <span> (possibly wrapped by mark
 * elements) and atomic units become a contentEditable="false" element. This
 * module walks those children to convert between the two coordinate systems.
 */



function isAtomicElement(node: Node): boolean {
  return node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).contentEditable === 'false';
}

function isCaretAnchor(node: Node): boolean {
  return node.nodeType === Node.ELEMENT_NODE && (node as Element).getAttribute('data-caret-anchor') === 'true';
}

function getTextNode(element: Node): Text | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  return (walker.nextNode() as Text) ?? null;
}

function getFirstTextNode(element: Node): Text | null {
  return getTextNode(element);
}

function getLastTextNode(element: Node): Text | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  let node: Node | null;
  while ((node = walker.nextNode()) !== null) {
    last = node as Text;
  }
  return last;
}

function getChildLength(node: Node): number {
  if (isCaretAnchor(node)) return 0;
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0;
  if (isAtomicElement(node)) return 1;
  const textNode = getTextNode(node);
  if (textNode) return textNode.textContent?.length ?? 0;
  return 0;
}

interface DOMPosition {
  node: Node;
  offset: number;
}

function positionAtOffset(root: HTMLElement, targetOffset: number): DOMPosition {
  let remaining = targetOffset;

  for (let i = 0; i < root.childNodes.length; i++) {
    const child = root.childNodes[i];

    if (child.nodeType === Node.TEXT_NODE) {
      const length = getChildLength(child);
      if (remaining <= length) {
        return { node: child, offset: remaining };
      }
      remaining -= length;
      continue;
    }

    if (isAtomicElement(child)) {
      if (remaining === 0) {
        // Prefer placing the caret inside the previous text node rather than at
        // a root boundary next to an atomic element, which browsers sometimes
        // render inside or below the atomic pill.
        const prev = root.childNodes[i - 1];
        if (prev && !isAtomicElement(prev)) {
          const textNode = getLastTextNode(prev);
          if (textNode) {
            const length = textNode.textContent?.length ?? 0;
            return { node: textNode, offset: length };
          }
        }
        return { node: root, offset: i };
      }
      remaining -= 1;
      if (remaining === 0) {
        // Place the caret inside the next text node when possible so the visual
        // caret sits immediately after the atomic pill instead of below/inside it.
        const next = root.childNodes[i + 1];
        if (next && !isAtomicElement(next)) {
          const textNode = getFirstTextNode(next);
          if (textNode) {
            return { node: textNode, offset: 0 };
          }
        }
        return { node: root, offset: i + 1 };
      }
      continue;
    }

    // Text-unit wrapper: find the leaf text node.
    const textNode = getTextNode(child);
    if (textNode) {
      const textLength = textNode.textContent?.length ?? 0;
      if (remaining <= textLength) {
        return { node: textNode, offset: remaining };
      }
      remaining -= textLength;
    }
  }

  return { node: root, offset: root.childNodes.length };
}

/**
 * Set a DOM selection inside `root`.
 *
 * When only `anchor` is provided, the selection is collapsed. Otherwise a
 * directional range is created from `anchor` to `focus`.
 */
export function setDOMSelection(root: HTMLElement, anchor: number, focus?: number): void {
  const selection = window.getSelection();
  if (!selection) return;

  const anchorPos = positionAtOffset(root, anchor);
  const focusPos = focus === undefined || focus === anchor
    ? anchorPos
    : positionAtOffset(root, focus);

  selection.setBaseAndExtent(anchorPos.node, anchorPos.offset, focusPos.node, focusPos.offset);
}

function offsetFromDOMPosition(root: HTMLElement, node: Node, nodeOffset: number): number {
  if (node === root) {
    let offset = 0;
    for (let i = 0; i < nodeOffset && i < root.childNodes.length; i++) {
      offset += getChildLength(root.childNodes[i]!);
    }
    return offset;
  }

  let offset = 0;

  for (const child of root.childNodes) {
    if (child === node) {
      if (isCaretAnchor(child)) return offset;
      return offset + Math.min(nodeOffset, getChildLength(child));
    }

    if (child.contains(node)) {
      if (isCaretAnchor(child)) return offset;
      if (isAtomicElement(child)) {
        return offset + (nodeOffset > 0 ? 1 : 0);
      }
      const textNode = getTextNode(child);
      if (textNode && node === textNode) {
        return offset + Math.min(nodeOffset, textNode.textContent?.length ?? 0);
      }
      return offset;
    }

    offset += getChildLength(child);
  }

  return offset;
}

/**
 * Read the current DOM selection inside `root` and return the logical offset.
 * Returns `null` if the selection is outside the editor.
 */
export function getDOMSelectionOffset(root: HTMLElement): number | null {
  const range = getDOMSelectionRange(root);
  if (!range) return null;
  return range.anchor;
}

/**
 * Read the current DOM selection inside `root` and return logical anchor/focus
 * offsets. Returns `null` if the selection is outside the editor.
 */
export function getDOMSelectionRange(
  root: HTMLElement,
): { anchor: number; focus: number; isCollapsed: boolean } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;

  const anchor = offsetFromDOMPosition(root, range.startContainer, range.startOffset);
  const focus = selection.isCollapsed
    ? anchor
    : offsetFromDOMPosition(root, range.endContainer, range.endOffset);

  return { anchor, focus, isCollapsed: selection.isCollapsed };
}

/**
 * Build a flat list of rendered unit wrappers from `root`.
 * Used by callers that need to reconcile DOM order with model units.
 */
export function getRenderedUnits(root: HTMLElement): Array<{ node: Node; size: number }> {
  const rendered: Array<{ node: Node; size: number }> = [];

  for (const child of root.childNodes) {
    if (isCaretAnchor(child)) continue;
    if (isAtomicElement(child)) {
      rendered.push({ node: child, size: 1 });
      continue;
    }

    const textNode = getTextNode(child);
    if (textNode) {
      rendered.push({ node: textNode, size: textNode.textContent?.length ?? 0 });
    }
  }

  return rendered;
}
