/**
 * KeyboardSelectionPlugin — Keyboard-based block selection
 *
 * Behavior:
 * - Esc → selects current block and exits edit mode
 * - Shift+left/right → normal text selection within block
 * - Shift+up/down → block selection, growing/reducing selection
 */

import { useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  $setSelection,
  KEY_ESCAPE_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  COMMAND_PRIORITY_HIGH,
} from 'lexical';
import { $isNodeBlockNode, NodeBlockNode } from '../nodes/NodeBlockNode';

/**
 * Helper: Select a block and all its children (card-style selection)
 */
function selectBlockWithChildren(rootEl: HTMLElement, blockId: string, selectedBlocks: Set<string>) {
  const blockEl = rootEl.querySelector(`[data-block-id=\"${blockId}\"]`) as HTMLElement;
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
 * Helper: Clear all selection classes
 */
function clearBlockSelection(rootEl: HTMLElement) {
  rootEl.querySelectorAll('.node-block--selected, .node-block--selected-child, .node-block--selected-first, .node-block--selected-last, .node-block--selected-single').forEach(el => {
    el.classList.remove('node-block--selected', 'node-block--selected-child', 'node-block--selected-first', 'node-block--selected-last', 'node-block--selected-single');
  });
}

export interface KeyboardSelectionPluginProps {
  editorId: string;
  readOnly?: boolean;
  onSelectionChange?: (selectedBlockIds: string[]) => void;
  onEscape?: () => void;
}

export function KeyboardSelectionPlugin({
  editorId: _editorId,
  readOnly,
  onSelectionChange,
  onEscape,
}: KeyboardSelectionPluginProps): null {
  const [editor] = useLexicalComposerContext();
  
  const selectedBlocks = useRef<Set<string>>(new Set());
  const anchorBlockId = useRef<string | null>(null);

  // ─── Clear selection when clicking in editor (entering edit mode) ─
  // Note: Click clearing is handled by BlockDragSelectionPlugin's mousedown handler
  // to avoid conflicts with drag selection. This plugin only manages keyboard selection.

  // ─── Escape: Select current block ─────────────────────────

  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (_event: KeyboardEvent) => {
        let blockIdToSelect: string | null = null;
        
        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;

          const anchorNode = selection.anchor.getNode();
          const blockNode = findParentNodeBlock(anchorNode);
          if (!blockNode) return;

          blockIdToSelect = blockNode.getBlockId();

          // Clear text selection first - exit edit mode
          $setSelection(null);
        });
        
        // Clear window selection
        const windowSelection = window.getSelection();
        if (windowSelection) {
          windowSelection.removeAllRanges();
        }

        // Apply block selection after Lexical update is complete
        if (blockIdToSelect) {
          // Use setTimeout to ensure Lexical has finished DOM updates
          setTimeout(() => {
            const rootEl = editor.getRootElement();
            if (!rootEl) return;
            
            clearBlockSelection(rootEl);
            selectedBlocks.current.clear();
            selectBlockWithChildren(rootEl, blockIdToSelect!, selectedBlocks.current);
            anchorBlockId.current = blockIdToSelect;

            onSelectionChange?.([...selectedBlocks.current]);
          }, 0);
        }

        // Call the original onEscape handler
        onEscape?.();
        
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, readOnly, onEscape, onSelectionChange]);

  // ─── Shift+Arrow Up: Extend/reduce block selection upward ────────

  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event: KeyboardEvent) => {
        // Only handle shift+arrow
        if (!event.shiftKey) return false;

        const rootEl = editor.getRootElement();
        if (!rootEl) return false;

        const allBlocks = Array.from(rootEl.querySelectorAll('[data-block-id]')) as HTMLElement[];

        // If no blocks selected yet, select current block
        if (selectedBlocks.current.size === 0) {
          let blockIdToSelect: string | null = null;
          
          editor.read(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) return;

            const anchorNode = selection.anchor.getNode();
            const blockNode = findParentNodeBlock(anchorNode);
            if (!blockNode) return;

            blockIdToSelect = blockNode.getBlockId();
          });
          
          if (blockIdToSelect) {
            // Clear text selection first
            editor.update(() => {
              $setSelection(null);
            });
            
            const windowSelection = window.getSelection();
            if (windowSelection) windowSelection.removeAllRanges();
            
            // Apply block selection after DOM is stable
            setTimeout(() => {
              clearBlockSelection(rootEl);
              selectedBlocks.current.clear();
              selectBlockWithChildren(rootEl, blockIdToSelect!, selectedBlocks.current);
              anchorBlockId.current = blockIdToSelect;
              onSelectionChange?.([...selectedBlocks.current]);
            }, 0);
          }
        } else {
          // Extend/shrink existing selection
          const anchorEl = anchorBlockId.current ? 
            rootEl.querySelector(`[data-block-id="${anchorBlockId.current}"]`) as HTMLElement : null;
          const selectedElements = allBlocks.filter(el => 
            selectedBlocks.current.has(el.getAttribute('data-block-id')!)
          );
          
          if (selectedElements.length === 0) return false;

          const topElement = selectedElements[0];
          const bottomElement = selectedElements[selectedElements.length - 1];
          const topIndex = allBlocks.indexOf(topElement);
          const bottomIndex = allBlocks.indexOf(bottomElement);
          const anchorIndex = anchorEl ? allBlocks.indexOf(anchorEl) : topIndex;

          // If anchor is at top, extend upward
          if (anchorIndex === topIndex && topIndex > 0) {
            clearBlockSelection(rootEl);
            selectedBlocks.current.clear();
            for (let i = topIndex - 1; i <= bottomIndex; i++) {
              const blockId = allBlocks[i].getAttribute('data-block-id');
              if (blockId) {
                selectBlockWithChildren(rootEl, blockId, selectedBlocks.current);
              }
            }
            onSelectionChange?.([...selectedBlocks.current]);
          }
          // If anchor is at bottom, shrink selection from bottom
          else if (anchorIndex === bottomIndex && selectedElements.length > 1) {
            clearBlockSelection(rootEl);
            selectedBlocks.current.clear();
            for (let i = topIndex; i < bottomIndex; i++) {
              const blockId = allBlocks[i].getAttribute('data-block-id');
              if (blockId) {
                selectBlockWithChildren(rootEl, blockId, selectedBlocks.current);
              }
            }
            onSelectionChange?.([...selectedBlocks.current]);
          }
        }

        event.preventDefault();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, readOnly, onSelectionChange]);

  // ─── Shift+Arrow Down: Extend/reduce block selection downward ────

  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        // Only handle shift+arrow
        if (!event.shiftKey) return false;

        const rootEl = editor.getRootElement();
        if (!rootEl) return false;

        const allBlocks = Array.from(rootEl.querySelectorAll('[data-block-id]')) as HTMLElement[];

        // If no blocks selected yet, select current block
        if (selectedBlocks.current.size === 0) {
          let blockIdToSelect: string | null = null;
          
          editor.read(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) return;

            const anchorNode = selection.anchor.getNode();
            const blockNode = findParentNodeBlock(anchorNode);
            if (!blockNode) return;

            blockIdToSelect = blockNode.getBlockId();
          });
          
          if (blockIdToSelect) {
            // Clear text selection first
            editor.update(() => {
              $setSelection(null);
            });
            
            const windowSelection = window.getSelection();
            if (windowSelection) windowSelection.removeAllRanges();
            
            // Apply block selection after DOM is stable
            setTimeout(() => {
              clearBlockSelection(rootEl);
              selectedBlocks.current.clear();
              selectBlockWithChildren(rootEl, blockIdToSelect!, selectedBlocks.current);
              anchorBlockId.current = blockIdToSelect;
              onSelectionChange?.([...selectedBlocks.current]);
            }, 0);
          }
        } else {
          // Extend/shrink existing selection
          const anchorEl = anchorBlockId.current ? 
            rootEl.querySelector(`[data-block-id="${anchorBlockId.current}"]`) as HTMLElement : null;
          const selectedElements = allBlocks.filter(el => 
            selectedBlocks.current.has(el.getAttribute('data-block-id')!)
          );
          
          if (selectedElements.length === 0) return false;

          const topElement = selectedElements[0];
          const bottomElement = selectedElements[selectedElements.length - 1];
          const topIndex = allBlocks.indexOf(topElement);
          const bottomIndex = allBlocks.indexOf(bottomElement);
          const anchorIndex = anchorEl ? allBlocks.indexOf(anchorEl) : bottomIndex;

          // If anchor is at bottom, extend downward
          if (anchorIndex === bottomIndex && bottomIndex < allBlocks.length - 1) {
            clearBlockSelection(rootEl);
            selectedBlocks.current.clear();
            for (let i = topIndex; i <= bottomIndex + 1; i++) {
              const blockId = allBlocks[i].getAttribute('data-block-id');
              if (blockId) {
                selectBlockWithChildren(rootEl, blockId, selectedBlocks.current);
              }
            }
            onSelectionChange?.([...selectedBlocks.current]);
          }
          // If anchor is at top, shrink selection from top
          else if (anchorIndex === topIndex && selectedElements.length > 1) {
            clearBlockSelection(rootEl);
            selectedBlocks.current.clear();
            for (let i = topIndex + 1; i <= bottomIndex; i++) {
              const blockId = allBlocks[i].getAttribute('data-block-id');
              if (blockId) {
                selectBlockWithChildren(rootEl, blockId, selectedBlocks.current);
              }
            }
            onSelectionChange?.([...selectedBlocks.current]);
          }
        }

        event.preventDefault();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, readOnly, onSelectionChange]);

  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────

function findParentNodeBlock(node: any): NodeBlockNode | null {
  let current = node;
  while (current != null) {
    if ($isNodeBlockNode(current)) return current;
    current = current.getParent?.();
  }
  return null;
}
