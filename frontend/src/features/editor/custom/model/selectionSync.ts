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

/**
 * Set a collapsed DOM selection at the given logical offset inside `root`.
 */
export function setDOMSelection(root: HTMLElement, offset: number): void {
  const selection = window.getSelection();
  if (!selection) return;

  let remaining = offset;

  for (const child of root.childNodes) {
    const length = getChildLength(child);

    if (child.nodeType === Node.TEXT_NODE) {
      if (remaining <= length) {
        selection.setBaseAndExtent(child, remaining, child, remaining);
        return;
      }
      remaining -= length;
      continue;
    }

    if (isAtomicElement(child)) {
      if (remaining === 0) {
        const range = document.createRange();
        range.setStartBefore(child);
        range.setEndBefore(child);
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      if (remaining >= 1) {
        remaining -= 1;
        if (remaining === 0) {
          const range = document.createRange();
          range.setStartAfter(child);
          range.setEndAfter(child);
          selection.removeAllRanges();
          selection.addRange(range);
          return;
        }
      }
      continue;
    }

    // Text-unit wrapper: find the leaf text node.
    const textNode = getTextNode(child);
    if (textNode) {
      const textLength = textNode.textContent?.length ?? 0;
      if (remaining <= textLength) {
        selection.setBaseAndExtent(textNode, remaining, textNode, remaining);
        return;
      }
      remaining -= textLength;
    }
  }

  // Place at end if offset is past content.
  if (root.lastChild) {
    const range = document.createRange();
    range.setStartAfter(root.lastChild);
    range.setEndAfter(root.lastChild);
    selection.removeAllRanges();
    selection.addRange(range);
  }
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
