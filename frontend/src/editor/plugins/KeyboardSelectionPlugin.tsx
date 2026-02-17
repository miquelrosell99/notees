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
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  KEY_ESCAPE_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_BACKSPACE_COMMAND,
  COMMAND_PRIORITY_HIGH,
} from 'lexical';
import { $isBlockNode } from '../nodes/BlockNode';
import { selectBlockWithChildren, clearBlockSelection, findParentNodeBlock } from '../utils/selectionUtils';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';

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

  // ─── Helper: apply block selection after clearing text selection ─
  const applyBlockSelection = (blockId: string) => {
    const rootEl = editor.getRootElement();
    if (!rootEl) return;
    clearBlockSelection(rootEl);
    selectedBlocks.current.clear();
    selectBlockWithChildren(rootEl, blockId, selectedBlocks.current);
    anchorBlockId.current = blockId;
    onSelectionChange?.([...selectedBlocks.current]);
  };

  // ─── Clear selection when clicking in editor (entering edit mode) ─
  // Note: Click clearing is handled by BlockDragSelectionPlugin's mousedown handler
  // to avoid conflicts with drag selection. This plugin only manages keyboard selection.

  // ─── Escape: Toggle between edit mode → selection mode → clear ─────────

  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (_event: KeyboardEvent) => {
        const rootEl = editor.getRootElement();
        if (!rootEl) return true;
        
        // Check if in selection mode (blocks are selected)
        const hasBlockSelection = selectedBlocks.current.size > 0;
        
        if (hasBlockSelection) {
          // Selection mode → clear selection
          clearBlockSelection(rootEl);
          selectedBlocks.current.clear();
          onSelectionChange?.([]);
        } else {
          // Edit mode → select current block
          let blockIdToSelect: string | null = null;
          
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            const anchorNode = selection.anchor.getNode();
            const blockNode = findParentNodeBlock(anchorNode);
            if (blockNode) {
              blockIdToSelect = blockNode.getBlockId();
            }
          }

          if (blockIdToSelect) {
            // Clear text selection in a separate update
            editor.update(() => { $setSelection(null); });
            window.getSelection()?.removeAllRanges();
            // Use queueMicrotask to ensure Lexical has finished DOM updates
            queueMicrotask(() => applyBlockSelection(blockIdToSelect!));
          }
        }

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
          
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            const anchorNode = selection.anchor.getNode();
            const blockNode = findParentNodeBlock(anchorNode);
            if (blockNode) {
              blockIdToSelect = blockNode.getBlockId();
            }
          }
          
          if (blockIdToSelect) {
            editor.update(() => { $setSelection(null); });
            window.getSelection()?.removeAllRanges();
            queueMicrotask(() => applyBlockSelection(blockIdToSelect!));
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
          
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            const anchorNode = selection.anchor.getNode();
            const blockNode = findParentNodeBlock(anchorNode);
            if (blockNode) {
              blockIdToSelect = blockNode.getBlockId();
            }
          }
          
          if (blockIdToSelect) {
            editor.update(() => { $setSelection(null); });
            window.getSelection()?.removeAllRanges();
            queueMicrotask(() => applyBlockSelection(blockIdToSelect!));
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

  // ─── Left/Right: Deselect and place cursor in anchor block ──────

  useEffect(() => {
    if (readOnly) return;

    const handleArrowLeft = (event: KeyboardEvent) => {
      if (event.shiftKey) return false; // Let shift+arrow be handled elsewhere
      if (selectedBlocks.current.size === 0) return false; // Not in selection mode

      event.preventDefault();
      
      const rootEl = editor.getRootElement();
      if (!rootEl) return true;

      const blockIdToFocus = anchorBlockId.current || [...selectedBlocks.current][0];
      
      clearBlockSelection(rootEl);
      selectedBlocks.current.clear();
      anchorBlockId.current = null;
      onSelectionChange?.([]);

      // Focus at start of anchor block
      editor.update(() => {
        // Find the block node via public API
        const blockNode = $getRoot().getChildren().find(
          node => $isBlockNode(node) && node.getBlockId() === blockIdToFocus
        );
        
        if (blockNode) {
          const firstChild = blockNode.getFirstDescendant();
          if (firstChild) {
            firstChild.selectStart();
          }
        }
      });

      return true;
    };

    const handleArrowRight = (event: KeyboardEvent) => {
      if (event.shiftKey) return false;
      if (selectedBlocks.current.size === 0) return false;

      event.preventDefault();
      
      const rootEl = editor.getRootElement();
      if (!rootEl) return true;

      const blockIdToFocus = anchorBlockId.current || [...selectedBlocks.current][0];
      
      clearBlockSelection(rootEl);
      selectedBlocks.current.clear();
      anchorBlockId.current = null;
      onSelectionChange?.([]);

      // Focus at end of anchor block
      editor.update(() => {
        // Find the block node via public API
        const blockNode = $getRoot().getChildren().find(
          node => $isBlockNode(node) && node.getBlockId() === blockIdToFocus
        );
        
        if (blockNode) {
          const lastChild = blockNode.getLastDescendant();
          if (lastChild) {
            lastChild.selectEnd();
          }
        }
      });

      return true;
    };

    const unsubLeft = editor.registerCommand(KEY_ARROW_LEFT_COMMAND, handleArrowLeft, COMMAND_PRIORITY_HIGH);
    const unsubRight = editor.registerCommand(KEY_ARROW_RIGHT_COMMAND, handleArrowRight, COMMAND_PRIORITY_HIGH);

    return () => {
      unsubLeft();
      unsubRight();
    };
  }, [editor, readOnly, onSelectionChange]);

  // ─── Delete / Backspace: Delete all selected blocks ────────────

  useEffect(() => {
    if (readOnly) return;

    const handleDeleteSelected = (_event: KeyboardEvent) => {
      if (selectedBlocks.current.size === 0) return false; // Not in selection mode

      const rootEl = editor.getRootElement();
      if (!rootEl) return true;

      // Collect all selected blockIds before clearing selection
      const blockIds = [...selectedBlocks.current];

      // Clear visual selection
      clearBlockSelection(rootEl);
      selectedBlocks.current.clear();
      anchorBlockId.current = null;
      onSelectionChange?.([]);

      // Batch-delete all selected blocks via the runtime
      const runtime = getNodeGraphRuntime();
      runtime.applyIntent({
        type: 'batch',
        intents: blockIds.map(blockId => ({ type: 'delete_block' as const, blockId })),
      });
      runtime.flushEvents();

      return true;
    };

    const unsubDelete = editor.registerCommand(KEY_DELETE_COMMAND, handleDeleteSelected, COMMAND_PRIORITY_HIGH);
    const unsubBackspace = editor.registerCommand(KEY_BACKSPACE_COMMAND, handleDeleteSelected, COMMAND_PRIORITY_HIGH);

    return () => {
      unsubDelete();
      unsubBackspace();
    };
  }, [editor, readOnly, onSelectionChange]);

  // ─── Alt+Shift+Up/Down: Move selected blocks ────────────────────

  useEffect(() => {
    if (readOnly) return;

    const handleMoveUp = (event: KeyboardEvent) => {
      // Only handle Alt+Shift+ArrowUp
      if (!event.altKey || !event.shiftKey) return false;
      if (selectedBlocks.current.size === 0) return false; // Not in selection mode

      event.preventDefault();

      const rootEl = editor.getRootElement();
      if (!rootEl) return true;

      // Get all blocks in document order
      const allBlocks = Array.from(rootEl.querySelectorAll('[data-block-id]')) as HTMLElement[];
      const allSelectedIds = [...selectedBlocks.current];
      
      // Get runtime and filter to only top-level selected blocks (exclude children)
      const runtime = getNodeGraphRuntime();
      const topLevelSelected = allSelectedIds.filter(blockId => {
        const node = runtime.getNode(blockId);
        if (!node?.parentId) return true;
        return !selectedBlocks.current.has(node.parentId);
      });

      // Sort by document order (top to bottom)
      const sortedBlocks = topLevelSelected.sort((a, b) => {
        const aEl = allBlocks.find(el => el.getAttribute('data-block-id') === a);
        const bEl = allBlocks.find(el => el.getAttribute('data-block-id') === b);
        if (!aEl || !bEl) return 0;
        return allBlocks.indexOf(aEl) - allBlocks.indexOf(bEl);
      });

      // Move each block up (process top to bottom)
      runtime.applyIntent({
        type: 'batch',
        intents: sortedBlocks.map(blockId => ({ type: 'move_up' as const, blockId })),
      });
      runtime.flushEvents();

      return true;
    };

    const handleMoveDown = (event: KeyboardEvent) => {
      // Only handle Alt+Shift+ArrowDown
      if (!event.altKey || !event.shiftKey) return false;
      if (selectedBlocks.current.size === 0) return false; // Not in selection mode

      event.preventDefault();

      const rootEl = editor.getRootElement();
      if (!rootEl) return true;

      // Get all blocks in document order
      const allBlocks = Array.from(rootEl.querySelectorAll('[data-block-id]')) as HTMLElement[];
      const allSelectedIds = [...selectedBlocks.current];
      
      // Get runtime and filter to only top-level selected blocks (exclude children)
      const runtime = getNodeGraphRuntime();
      const topLevelSelected = allSelectedIds.filter(blockId => {
        const node = runtime.getNode(blockId);
        if (!node?.parentId) return true;
        return !selectedBlocks.current.has(node.parentId);
      });

      // Sort by document order (top to bottom), then reverse for bottom-to-top processing
      const sortedBlocks = topLevelSelected
        .sort((a, b) => {
          const aEl = allBlocks.find(el => el.getAttribute('data-block-id') === a);
          const bEl = allBlocks.find(el => el.getAttribute('data-block-id') === b);
          if (!aEl || !bEl) return 0;
          return allBlocks.indexOf(aEl) - allBlocks.indexOf(bEl);
        })
        .reverse();

      // Move each block down (process bottom to top)
      runtime.applyIntent({
        type: 'batch',
        intents: sortedBlocks.map(blockId => ({ type: 'move_down' as const, blockId })),
      });
      runtime.flushEvents();

      return true;
    };

    const unsubUp = editor.registerCommand(KEY_ARROW_UP_COMMAND, handleMoveUp, COMMAND_PRIORITY_HIGH);
    const unsubDown = editor.registerCommand(KEY_ARROW_DOWN_COMMAND, handleMoveDown, COMMAND_PRIORITY_HIGH);

    return () => {
      unsubUp();
      unsubDown();
    };
  }, [editor, readOnly]);

  return null;
}
