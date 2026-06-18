/**
 * Shared selection utilities for editor plugins.
 */

/**
 * Trims leading and trailing whitespace from the current text selection.
 * Returns true if the selection was modified, false otherwise.
 *
 * This should be called within editor.update() to modify the selection.
 *
 * @param selection - The RangeSelection to trim
 * @returns boolean indicating if the selection was modified
 */
export function $trimSelectionWhitespace(selection: any): boolean {
  if (!selection || selection.isCollapsed()) {
    return false;
  }

  const anchor = selection.anchor;
  const focus = selection.focus;

  // Determine start and end (handle reverse selections)
  const isBackward = selection.isBackward();
  const startPoint = isBackward ? focus : anchor;
  const endPoint = isBackward ? anchor : focus;

  const startNode = startPoint.getNode();
  const endNode = endPoint.getNode();

  // Only trim if selection is within text nodes
  if (startNode.getType() !== 'text' || endNode.getType() !== 'text') {
    return false;
  }

  let startOffset = startPoint.offset;
  let endOffset = endPoint.offset;
  let modified = false;

  // Trim leading whitespace from start
  if (startNode === endNode) {
    // Single node selection
    const text = startNode.getTextContent();
    const selectedText = text.slice(startOffset, endOffset);
    const trimmedStart = selectedText.replace(/^[\s\u200B]+/, '');
    const trimmedText = trimmedStart.replace(/[\s\u200B]+$/, '');

    if (trimmedText.length === 0) {
      // Selection is all whitespace, don't modify
      return false;
    }

    const leadingWhitespace = selectedText.length - trimmedStart.length;
    const trailingWhitespace = trimmedStart.length - trimmedText.length;

    if (leadingWhitespace > 0 || trailingWhitespace > 0) {
      startOffset += leadingWhitespace;
      endOffset -= trailingWhitespace;
      modified = true;
    }
  } else {
    // Multi-node selection - trim start node
    const startText = startNode.getTextContent();
    const startSelectedText = startText.slice(startOffset);
    const trimmedStartText = startSelectedText.replace(/^[\s\u200B]+/, '');
    const leadingWhitespace = startSelectedText.length - trimmedStartText.length;

    if (leadingWhitespace > 0) {
      startOffset += leadingWhitespace;
      modified = true;
    }

    // Trim end node
    const endText = endNode.getTextContent();
    const endSelectedText = endText.slice(0, endOffset);
    const trimmedEndText = endSelectedText.replace(/[\s\u200B]+$/, '');
    const trailingWhitespace = endSelectedText.length - trimmedEndText.length;

    if (trailingWhitespace > 0) {
      endOffset -= trailingWhitespace;
      modified = true;
    }
  }

  // Apply the trimmed selection
  if (modified) {
    if (isBackward) {
      selection.setTextNodeRange(endNode, endOffset, startNode, startOffset);
    } else {
      selection.setTextNodeRange(startNode, startOffset, endNode, endOffset);
    }
  }

  return modified;
}
