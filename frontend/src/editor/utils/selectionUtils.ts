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
  const blockEl = rootEl.querySelector(`[data-block-id="${blockId}"]`) as HTMLElement;
  if (!blockEl) return;

  const blockDepth = parseInt(blockEl.getAttribute('data-depth') || '0', 10);
  const allBlocks = Array.from(rootEl.querySelectorAll('[data-block-id]')) as HTMLElement[];
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
