/**
 * Shared selection utilities for block selection plugins.
 *
 * Used by BlockDragSelectionPlugin and KeyboardSelectionPlugin
 * to avoid code duplication.
 */

import { $isBlockNode, type BlockNode } from '../nodes/BlockNode';

/**
 * Select a block and all its children (card-style selection).
 * Applies CSS classes directly to DOM elements for visual state.
 */
export function selectBlockWithChildren(
  rootEl: HTMLElement,
  blockId: string,
  selectedBlocks: Set<string>,
): void {
  const blockEl = rootEl.querySelector(`.node-block[data-block-id="${blockId}"]`) as HTMLElement;
  if (!blockEl) return;

  const blockDepth = parseInt(blockEl.getAttribute('data-depth') || '0', 10);
  // Use .node-block selector to avoid matching bullet-wrapper elements
  // which also carry data-block-id but lack data-depth
  const allBlocks = Array.from(rootEl.querySelectorAll('.node-block[data-block-id]')) as HTMLElement[];
  const blockIndex = allBlocks.indexOf(blockEl);

  // Add the block itself
  selectedBlocks.add(blockId);
  blockEl.classList.add('node-block--selected');

  // Find and add all children (blocks with greater depth that follow)
  const children: HTMLElement[] = [];
  for (let i = blockIndex + 1; i < allBlocks.length; i++) {
    const nextBlock = allBlocks[i];
    const nextDepth = parseInt(nextBlock.getAttribute('data-depth') || '0', 10);

    // Stop when we hit a block at same or lesser depth
    if (nextDepth <= blockDepth) break;

    const nextBlockId = nextBlock.getAttribute('data-block-id');
    if (nextBlockId) {
      selectedBlocks.add(nextBlockId);
      nextBlock.classList.add('node-block--selected-child');
      children.push(nextBlock);
    }
  }

  // Apply first/last/single classes for proper card styling
  if (children.length === 0) {
    blockEl.classList.add('node-block--selected-single');
  } else {
    blockEl.classList.add('node-block--selected-first');
    children[children.length - 1].classList.add('node-block--selected-last');
  }

  // Update the selection overlay to cover all selected blocks
  updateSelectionOverlay(rootEl);
}

/**
 * Create/update the selection card overlay to cover all currently selected blocks.
 * Uses getBoundingClientRect for accurate viewport-relative positioning.
 */
function updateSelectionOverlay(rootEl: HTMLElement): void {
  const editorWrapper = rootEl.closest('.notees-editor') as HTMLElement;
  if (!editorWrapper) return;

  // Remove existing overlay
  editorWrapper.querySelectorAll('.block-selection-card').forEach(el => el.remove());

  // Find all currently selected blocks (including children)
  const allSelected = rootEl.querySelectorAll(
    '.node-block--selected, .node-block--selected-child'
  ) as NodeListOf<HTMLElement>;
  if (allSelected.length === 0) return;

  const firstEl = allSelected[0];
  const lastEl = allSelected[allSelected.length - 1];

  // Use getBoundingClientRect for reliable positioning regardless of
  // offsetParent chain, CSS contain, or intermediate wrappers
  const editorRect = editorWrapper.getBoundingClientRect();
  const firstRect = firstEl.getBoundingClientRect();
  const lastRect = lastEl.getBoundingClientRect();

  // Find the leftmost edge — use the primary selected block's position
  const parentSelected = rootEl.querySelector('.node-block--selected') as HTMLElement;
  const parentRect = parentSelected ? parentSelected.getBoundingClientRect() : firstRect;

  const top = firstRect.top - editorRect.top + editorWrapper.scrollTop - 2;
  const left = parentRect.left - editorRect.left + editorWrapper.scrollLeft - 6;
  const height = lastRect.bottom - firstRect.top + 4;

  const overlay = document.createElement('div');
  overlay.className = 'block-selection-card';
  overlay.style.top = `${top}px`;
  overlay.style.left = `${left}px`;
  overlay.style.right = '0';
  overlay.style.height = `${height}px`;
  editorWrapper.appendChild(overlay);
}

/**
 * Clear all block selection CSS classes from the editor.
 */
export function clearBlockSelection(rootEl: HTMLElement): void {
  const selectionClasses = [
    'node-block--selected',
    'node-block--selected-child',
    'node-block--selected-first',
    'node-block--selected-last',
    'node-block--selected-single',
  ];
  const selector = selectionClasses.map(c => `.${c}`).join(', ');
  rootEl.querySelectorAll(selector).forEach(el => {
    el.classList.remove(...selectionClasses);
  });

  // Remove overlay div(s)
  const editorWrapper = rootEl.closest('.notees-editor');
  if (editorWrapper) {
    editorWrapper.querySelectorAll('.block-selection-card').forEach(el => el.remove());
  }
}

/**
 * Walk up the Lexical node tree to find the parent BlockNode.
 */
export function findParentNodeBlock(node: any): BlockNode | null {
  let current = node;
  while (current != null) {
    if ($isBlockNode(current)) return current;
    current = current.getParent?.();
  }
  return null;
}

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
