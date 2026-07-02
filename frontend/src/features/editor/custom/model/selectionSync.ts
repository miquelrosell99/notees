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

function getTextNode(element: Node): Text | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  return (walker.nextNode() as Text) ?? null;
}

function getChildLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0;
  if (isAtomicElement(node)) return 1;
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
        return { node: root, offset: i };
      }
      remaining -= 1;
      if (remaining === 0) {
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

/**
 * Read the current DOM selection inside `root` and return the logical offset.
 * Returns `null` if the selection is outside the editor.
 */
export function getDOMSelectionOffset(root: HTMLElement): number | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  const anchorNode = range.startContainer;
  const anchorOffset = range.startOffset;

  if (!root.contains(anchorNode)) return null;

  let offset = 0;

  for (const child of root.childNodes) {
    if (child === anchorNode) {
      return offset + Math.min(anchorOffset, getChildLength(child));
    }

    if (child.contains(anchorNode)) {
      // Anchor is inside a text-unit wrapper.
      const textNode = getTextNode(child);
      if (textNode && anchorNode === textNode) {
        return offset + Math.min(anchorOffset, textNode.textContent?.length ?? 0);
      }
      return offset;
    }

    if (isAtomicElement(child)) {
      offset += 1;
    } else {
      const textNode = getTextNode(child);
      if (textNode) {
        offset += textNode.textContent?.length ?? 0;
      }
    }
  }

  return offset;
}

/**
 * Build a flat list of rendered unit wrappers from `root`.
 * Used by callers that need to reconcile DOM order with model units.
 */
export function getRenderedUnits(root: HTMLElement): Array<{ node: Node; size: number }> {
  const rendered: Array<{ node: Node; size: number }> = [];

  for (const child of root.childNodes) {
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
