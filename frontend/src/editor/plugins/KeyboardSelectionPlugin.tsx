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
  COMMAND_PRIORITY_CRITICAL,
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
  const focusBlockId = useRef<string | null>(null);

  // ─── Helper: apply block selection after clearing text selection ─
  const applyBlockSelection = (blockId: string) => {
    const rootEl = editor.getRootElement();
    if (!rootEl) return;
    clearBlockSelection(rootEl);
    selectedBlocks.current.clear();
    selectBlockWithChildren(rootEl, blockId, selectedBlocks.current);
    anchorBlockId.current = blockId;
    focusBlockId.current = blockId;
    onSelectionChange?.([...selectedBlocks.current]);
  };

  // ─── Helpers: document-order selection ───────────────────────────

  const getAllBlockIdsInDocumentOrder = (rootEl: HTMLElement): string[] => {
    return Array.from(rootEl.querySelectorAll('.node-block[data-block-id]'))
      .map(el => el.getAttribute('data-block-id'))
      .filter((id): id is string => id !== null);
  };

  const applyDocumentOrderSelection = (
    rootEl: HTMLElement,
    anchorId: string,
    focusId: string,
  ): void => {
    const allBlockIds = getAllBlockIdsInDocumentOrder(rootEl);
    const anchorIndex = allBlockIds.indexOf(anchorId);
    const focusIndex = allBlockIds.indexOf(focusId);

    if (anchorIndex === -1 || focusIndex === -1) return;

    const start = Math.min(anchorIndex, focusIndex);
    const end = Math.max(anchorIndex, focusIndex);

    clearBlockSelection(rootEl);
    selectedBlocks.current.clear();

    for (let i = start; i <= end; i++) {
      selectBlockWithChildren(rootEl, allBlockIds[i], selectedBlocks.current);
    }

    onSelectionChange?.([...selectedBlocks.current]);
  };

  const moveFocusDown = (rootEl: HTMLElement): boolean => {
    const allBlockIds = getAllBlockIdsInDocumentOrder(rootEl);
    const anchorId = anchorBlockId.current;
    const focusId = focusBlockId.current || anchorId;
    if (!anchorId || !focusId) return false;

    const anchorIndex = allBlockIds.indexOf(anchorId);
    const focusIndex = allBlockIds.indexOf(focusId);
    if (focusIndex === -1 || focusIndex >= allBlockIds.length - 1) return false;

    const newFocusId = allBlockIds[focusIndex + 1];

    // Lock: when extending downward (focus at or below anchor), don't cross
    // out of the current subtree to a higher-level block
    if (focusIndex >= anchorIndex) {
      const anchorEl = rootEl.querySelector(`.node-block[data-block-id="${anchorId}"]`) as HTMLElement | null;
      const nextEl = rootEl.querySelector(`.node-block[data-block-id="${newFocusId}"]`) as HTMLElement | null;
      if (anchorEl && nextEl) {
        const anchorDepth = parseInt(anchorEl.getAttribute('data-depth') || '0', 10);
        const nextDepth = parseInt(nextEl.getAttribute('data-depth') || '0', 10);
        if (nextDepth < anchorDepth) return false;
      }
    }

    applyDocumentOrderSelection(rootEl, anchorId, newFocusId);
    focusBlockId.current = newFocusId;
    return true;
  };

  const moveFocusUp = (rootEl: HTMLElement): boolean => {
    const allBlockIds = getAllBlockIdsInDocumentOrder(rootEl);
    const anchorId = anchorBlockId.current;
    const focusId = focusBlockId.current || anchorId;
    if (!anchorId || !focusId) return false;

    const focusIndex = allBlockIds.indexOf(focusId);
    if (focusIndex <= 0) return false;

    const newFocusId = allBlockIds[focusIndex - 1];
    applyDocumentOrderSelection(rootEl, anchorId, newFocusId);
    focusBlockId.current = newFocusId;
    return true;
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
        focusBlockId.current = null;
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
          _event.preventDefault();
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
          editor.blur();
          const activeEl = document.activeElement;
          if (activeEl && rootEl.contains(activeEl) && activeEl !== rootEl) {
            (activeEl as HTMLElement).blur();
          }
          _event.preventDefault();
        }

        onEscape?.();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, readOnly, onEscape, onSelectionChange]);

  // Document-level Escape handler.
  // Acts as a fallback when the Lexical command handler doesn't fire, and also
  // handles clearing an existing block selection when the editor is blurred.
  useEffect(() => {
    if (readOnly) return;

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // If the Lexical handler above already handled this Escape, do nothing.
      if (event.defaultPrevented) return;

      const rootEl = editor.getRootElement();
      if (!rootEl) return;

      const editorHasFocus = rootEl.contains(document.activeElement);

      // ── Fallback: editor is focused but Lexical command didn't fire ──
      if (editorHasFocus && selectedBlocks.current.size === 0) {
        let blockIdToSelect: string | null = null;
        editor.read(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            const anchorNode = selection.anchor.getNode();
            const blockNode = findParentNodeBlock(anchorNode);
            if (blockNode) {
              blockIdToSelect = blockNode.getBlockId();
            }
          }
        });

        if (blockIdToSelect) {
          window.getSelection()?.removeAllRanges();
          applyBlockSelection(blockIdToSelect);
          editor.blur();
          event.preventDefault();
        }

        onEscape?.();
        return;
      }

      // ── Editor focused with blocks selected: clear them ──
      if (editorHasFocus && selectedBlocks.current.size > 0) {
        clearBlockSelection(rootEl);
        selectedBlocks.current.clear();
        anchorBlockId.current = null;
        onSelectionChange?.([]);
        onEscape?.();
        event.preventDefault();
        return;
      }

      // ── Editor blurred with blocks selected: clear them ──
      if (selectedBlocks.current.size === 0) return;

      event.preventDefault();
      clearBlockSelection(rootEl);
      selectedBlocks.current.clear();
      anchorBlockId.current = null;
      onSelectionChange?.([]);
      onEscape?.();
    };

    document.addEventListener('keydown', handleGlobalEscape);
    return () => document.removeEventListener('keydown', handleGlobalEscape);
  }, [editor, readOnly, onSelectionChange, onEscape]);

  // ─── Shift+Arrow Up: Move focus boundary upward ──────────────────

  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event: KeyboardEvent) => {
        if (!event.shiftKey) return false;

        const rootEl = editor.getRootElement();
        if (!rootEl) return false;

        // If no blocks selected yet, start selection from current block
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
          // Editor still focused but blocks selected — extend via document order
          moveFocusUp(rootEl);
        }

        event.preventDefault();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, readOnly, onSelectionChange]);

  // ─── Shift+Arrow Down: Move focus boundary downward ──────────────

  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        if (!event.shiftKey) return false;

        const rootEl = editor.getRootElement();
        if (!rootEl) return false;

        // If no blocks selected yet, start selection from current block
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
          // Editor still focused but blocks selected — extend via document order
          moveFocusDown(rootEl);
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
      focusBlockId.current = null;
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
      focusBlockId.current = null;
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
      focusBlockId.current = null;
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

  // ─── Document-level keyboard handlers (for when editor is blurred) ─

  useEffect(() => {
    if (readOnly) return;

    const rootEl = editor.getRootElement();
    if (!rootEl) return;

    // Shift+ArrowUp: move focus boundary upward
    const handleShiftArrowUp = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowUp' || !event.shiftKey) return;
      if (event.defaultPrevented) return;
      if (selectedBlocks.current.size === 0) return;
      if (rootEl.contains(document.activeElement)) return;

      event.preventDefault();
      moveFocusUp(rootEl);
    };

    // Shift+ArrowDown: move focus boundary downward
    const handleShiftArrowDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown' || !event.shiftKey) return;
      if (event.defaultPrevented) return;
      if (selectedBlocks.current.size === 0) return;
      if (rootEl.contains(document.activeElement)) return;

      event.preventDefault();
      moveFocusDown(rootEl);
    };

    // ArrowLeft: re-enter edit mode at start of anchor block
    const handleArrowLeft = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' || event.shiftKey) return;
      if (event.defaultPrevented) return;
      if (selectedBlocks.current.size === 0) return;
      if (rootEl.contains(document.activeElement)) return;

      event.preventDefault();

      const blockIdToFocus = anchorBlockId.current || [...selectedBlocks.current][0];

      clearBlockSelection(rootEl);
      selectedBlocks.current.clear();
      anchorBlockId.current = null;
      focusBlockId.current = null;
      onSelectionChange?.([]);

      editor.focus(() => {
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
    };

    // ArrowRight: re-enter edit mode at end of anchor block
    const handleArrowRight = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowRight' || event.shiftKey) return;
      if (event.defaultPrevented) return;
      if (selectedBlocks.current.size === 0) return;
      if (rootEl.contains(document.activeElement)) return;

      event.preventDefault();

      const blockIdToFocus = anchorBlockId.current || [...selectedBlocks.current][0];

      clearBlockSelection(rootEl);
      selectedBlocks.current.clear();
      anchorBlockId.current = null;
      focusBlockId.current = null;
      onSelectionChange?.([]);

      editor.focus(() => {
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
    };

    document.addEventListener('keydown', handleShiftArrowUp);
    document.addEventListener('keydown', handleShiftArrowDown);
    document.addEventListener('keydown', handleArrowLeft);
    document.addEventListener('keydown', handleArrowRight);

    return () => {
      document.removeEventListener('keydown', handleShiftArrowUp);
      document.removeEventListener('keydown', handleShiftArrowDown);
      document.removeEventListener('keydown', handleArrowLeft);
      document.removeEventListener('keydown', handleArrowRight);
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

    const unsubUp = editor.registerCommand(KEY_ARROW_UP_COMMAND, handleMoveUp, COMMAND_PRIORITY_CRITICAL);
    const unsubDown = editor.registerCommand(KEY_ARROW_DOWN_COMMAND, handleMoveDown, COMMAND_PRIORITY_CRITICAL);

    return () => {
      unsubUp();
      unsubDown();
    };
  }, [editor, readOnly]);

  return null;
}
