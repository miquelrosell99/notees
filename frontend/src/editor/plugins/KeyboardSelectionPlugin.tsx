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
  $isElementNode,
  KEY_ESCAPE_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
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

  // ─── Clear block selection state when editor regains focus (user clicked back in) ─
  useEffect(() => {
    if (readOnly) return;

    const rootEl = editor.getRootElement();
    if (!rootEl) return;

    const handleFocus = () => {
      if (selectedBlocks.current.size > 0) {
        clearBlockSelection(rootEl);
        selectedBlocks.current.clear();
        anchorBlockId.current = null;
        onSelectionChange?.([]);
      }
    };

    rootEl.addEventListener('focus', handleFocus, true);
    return () => rootEl.removeEventListener('focus', handleFocus, true);
  }, [editor, readOnly, onSelectionChange]);

  // ─── Escape: Toggle between edit mode → selection mode → clear ─────────

  // Lexical command handles: edit mode → select current block
  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (_event: KeyboardEvent) => {
        const rootEl = editor.getRootElement();
        if (!rootEl) return true;
        
        // If blocks are already selected (shouldn't normally reach here since
        // editor is blurred in selection mode, but handle defensively)
        if (selectedBlocks.current.size > 0) {
          clearBlockSelection(rootEl);
          selectedBlocks.current.clear();
          anchorBlockId.current = null;
          onSelectionChange?.([]);
          onEscape?.();
          return true;
        }

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
          // Clear Lexical selection first
          editor.update(() => { $setSelection(null); });
          window.getSelection()?.removeAllRanges();
          // Apply block selection (CSS classes + overlay) while DOM is stable
          applyBlockSelection(blockIdToSelect);
          // Blur the editor so the custom caret hides and node-block--editing is removed
          rootEl.blur();
        }

        onEscape?.();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, readOnly, onEscape, onSelectionChange]);

  // Document-level Escape handler for deselecting blocks.
  // When blocks are selected the editor is blurred, so Lexical commands won't fire.
  useEffect(() => {
    if (readOnly) return;

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (selectedBlocks.current.size === 0) return;

      // If the editor has focus, let the Lexical command handler above deal with it
      const rootEl = editor.getRootElement();
      if (rootEl && rootEl.contains(document.activeElement)) return;

      event.preventDefault();
      if (rootEl) clearBlockSelection(rootEl);
      selectedBlocks.current.clear();
      anchorBlockId.current = null;
      onSelectionChange?.([]);
      onEscape?.();
    };

    document.addEventListener('keydown', handleGlobalEscape);
    return () => document.removeEventListener('keydown', handleGlobalEscape);
  }, [editor, readOnly, onSelectionChange, onEscape]);

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
          // Extend/shrink existing selection - only navigate among siblings
          const runtime = getNodeGraphRuntime();
          const anchorBlock = anchorBlockId.current ? runtime.getNode(anchorBlockId.current) : null;
          
          if (!anchorBlock) return false;
          
          // Get siblings at the same parent level
          const siblings = runtime.getSiblings(anchorBlock.blockId);
          const siblingIds = siblings.map(s => s.blockId);
          
          if (siblingIds.length === 0) return false;
          
          // Find anchor position in sibling list
          const anchorIndex = siblingIds.indexOf(anchorBlock.blockId);
          if (anchorIndex === -1) return false;
          
          // Determine current selection range within siblings
          const selectedSiblingIds = siblingIds.filter(id => 
            selectedBlocks.current.has(id)
          );
          
          if (selectedSiblingIds.length === 0) return false;
          
          const firstSelectedIndex = siblingIds.indexOf(selectedSiblingIds[0]);
          const lastSelectedIndex = siblingIds.indexOf(selectedSiblingIds[selectedSiblingIds.length - 1]);
          
          let newSelection: string[] = [];
          
          // Shift+Up: Prioritize shrinking toward anchor, then extending
          if (lastSelectedIndex > anchorIndex) {
            // Selection extends below anchor, shrink from bottom (move bottom toward anchor)
            newSelection = siblingIds.slice(firstSelectedIndex, lastSelectedIndex);
          } else if (firstSelectedIndex === anchorIndex && firstSelectedIndex > 0) {
            // At anchor and can extend upward
            newSelection = siblingIds.slice(firstSelectedIndex - 1, lastSelectedIndex + 1);
          } else if (firstSelectedIndex < anchorIndex) {
            // Selection extends above anchor, shrink from top (move top toward anchor)
            newSelection = siblingIds.slice(firstSelectedIndex + 1, lastSelectedIndex + 1);
          } else if (firstSelectedIndex === 0 && anchorIndex === 0 && anchorBlock.parentId) {
            // At first sibling - select parent block instead
            const parentBlock = runtime.getNode(anchorBlock.parentId);
            if (parentBlock) {
              clearBlockSelection(rootEl);
              selectedBlocks.current.clear();
              selectBlockWithChildren(rootEl, parentBlock.blockId, selectedBlocks.current);
              anchorBlockId.current = parentBlock.blockId;
              onSelectionChange?.([...selectedBlocks.current]);
              event.preventDefault();
              return true;
            }
          }
          
          if (newSelection.length > 0) {
            clearBlockSelection(rootEl);
            selectedBlocks.current.clear();
            for (const blockId of newSelection) {
              selectBlockWithChildren(rootEl, blockId, selectedBlocks.current);
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
          // Extend/shrink existing selection - only navigate among siblings
          const runtime = getNodeGraphRuntime();
          const anchorBlock = anchorBlockId.current ? runtime.getNode(anchorBlockId.current) : null;
          
          if (!anchorBlock) return false;
          
          // Get siblings at the same parent level
          const siblings = runtime.getSiblings(anchorBlock.blockId);
          const siblingIds = siblings.map(s => s.blockId);
          
          if (siblingIds.length === 0) return false;
          
          // Find anchor position in sibling list
          const anchorIndex = siblingIds.indexOf(anchorBlock.blockId);
          if (anchorIndex === -1) return false;
          
          // Determine current selection range within siblings
          const selectedSiblingIds = siblingIds.filter(id => 
            selectedBlocks.current.has(id)
          );
          
          if (selectedSiblingIds.length === 0) return false;
          
          const firstSelectedIndex = siblingIds.indexOf(selectedSiblingIds[0]);
          const lastSelectedIndex = siblingIds.indexOf(selectedSiblingIds[selectedSiblingIds.length - 1]);
          
          let newSelection: string[] = [];
          
          // Shift+Down: Prioritize shrinking toward anchor, then extending
          if (firstSelectedIndex < anchorIndex) {
            // Selection extends above anchor, shrink from top (move top toward anchor)
            newSelection = siblingIds.slice(firstSelectedIndex + 1, lastSelectedIndex + 1);
          } else if (lastSelectedIndex === anchorIndex && lastSelectedIndex < siblingIds.length - 1) {
            // At anchor and can extend downward
            newSelection = siblingIds.slice(firstSelectedIndex, lastSelectedIndex + 2);
          } else if (lastSelectedIndex > anchorIndex) {
            // Selection extends below anchor, shrink from bottom (move bottom toward anchor)
            newSelection = siblingIds.slice(firstSelectedIndex, lastSelectedIndex);
          } else if (lastSelectedIndex === siblingIds.length - 1 && anchorIndex === lastSelectedIndex && anchorBlock.parentId) {
            // At last sibling - select parent block instead
            const parentBlock = runtime.getNode(anchorBlock.parentId);
            if (parentBlock) {
              clearBlockSelection(rootEl);
              selectedBlocks.current.clear();
              selectBlockWithChildren(rootEl, parentBlock.blockId, selectedBlocks.current);
              anchorBlockId.current = parentBlock.blockId;
              onSelectionChange?.([...selectedBlocks.current]);
              event.preventDefault();
              return true;
            }
          }
          
          if (newSelection.length > 0) {
            clearBlockSelection(rootEl);
            selectedBlocks.current.clear();
            for (const blockId of newSelection) {
              selectBlockWithChildren(rootEl, blockId, selectedBlocks.current);
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
        
        if (blockNode && $isElementNode(blockNode)) {
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
        
        if (blockNode && $isElementNode(blockNode)) {
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
  // Document-level handler since editor is blurred during block selection

  useEffect(() => {
    if (readOnly) return;

    const handleDeleteKey = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      if (selectedBlocks.current.size === 0) return;

      // If editor has focus, let Lexical/BlockPlugin handle it
      const rootEl = editor.getRootElement();
      if (rootEl && rootEl.contains(document.activeElement)) return;

      event.preventDefault();

      // Collect all selected blockIds before clearing selection
      const blockIds = [...selectedBlocks.current];

      // Clear visual selection
      if (rootEl) clearBlockSelection(rootEl);
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
    };

    document.addEventListener('keydown', handleDeleteKey);
    return () => document.removeEventListener('keydown', handleDeleteKey);
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
