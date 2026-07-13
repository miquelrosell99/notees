/**
 * useBlockSelection — Mouse drag + keyboard block selection for BlockList.
 *
 * Replaces BlockDragSelectionPlugin and KeyboardSelectionPlugin.
 * Operates directly on the DOM — no editor context required.
 */

import { useEffect, useRef } from 'react';
import { useBlockSelectionStore } from '@/stores/blockSelectionStore';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import { getOperationRuntime } from '@/runtime';
import { getNode } from '@/runtime/graphHelpers';
import { getUndoEngine } from '@/stores/undoEngine';
import { getRuntimeEventBus } from '@/runtime/eventBus';
import { useInputContext } from '@/stores/inputContext';
import { copyRuntimeBlocksToClipboard, tryParseInternalFormat } from '@/utils/clipboardManager';
import { useClipboardStore } from '@/stores/clipboardStore';
import { pasteBlocksAfterBlock, flushAllContentSaves, isInsideEditorCompanion } from '@/features/editor';
import { generateUUID } from '@/utils/uuid';
import { clearClasses, applyClasses, getSiblingIds, type UseBlockSelectionOptions } from './useBlockSelection.utils';

export function useBlockSelection({ containerRef, blockIds, readOnly }: UseBlockSelectionOptions): void {
  const selectedIds = useBlockSelectionStore((s) => s.selectedIds);
  const anchorId = useBlockSelectionStore((s) => s.anchorId);
  const setDragging = useBlockSelectionStore((s) => s.setDragging);
  const selectSingle = useBlockSelectionStore((s) => s.selectSingle);
  const extendTo = useBlockSelectionStore((s) => s.extendTo);
  const clearSelection = useBlockSelectionStore((s) => s.clearSelection);
  const setSelectedIds = useBlockSelectionStore((s) => s.setSelectedIds);

  const isDragging = useRef(false);
  const isBlockSelectionMode = useRef(false);
  const dragStartPoint = useRef<{ x: number; y: number } | null>(null);
  const dragStartBlock = useRef<HTMLElement | null>(null);
  const lastHoveredBlock = useRef<string | null>(null);
  const dragRafId = useRef<number | null>(null);
  const justCompletedDrag = useRef(false);

  // Sync CSS classes whenever selection changes
  useEffect(() => {
    const rootEl = containerRef.current;
    if (!rootEl) return;
    applyClasses(rootEl, selectedIds);
    return () => {
      clearClasses(rootEl);
      const wrapper = rootEl.closest('.notees-editor');
      wrapper?.querySelectorAll('.block-selection-card').forEach((el) => el.remove());
    };
  }, [selectedIds, containerRef]);

  // Main selection effect
  useEffect(() => {
    if (readOnly) return;
    const rootEl = containerRef.current;
    if (!rootEl) return;

    // ── Mouse drag selection ───────────────────────────────────
    const handleMouseDown = (e: MouseEvent) => {
      if (useInputContext.getState().isOverlayOpen) return;
      const target = e.target as HTMLElement;
      if (target.closest('.bullet-wrapper') || target.closest('.block-collapse-arrow')) return;
      const blockEl = target.closest('[data-block-id]') as HTMLElement;
      if (!blockEl) return;
      if (blockEl.hasAttribute('data-ghost')) return;
      const blockId = blockEl.getAttribute('data-block-id');
      if (!blockId) return;

      if (!e.shiftKey && !justCompletedDrag.current) {
        clearSelection();
      }
      justCompletedDrag.current = false;

      isDragging.current = true;
      isBlockSelectionMode.current = false;
      dragStartPoint.current = { x: e.clientX, y: e.clientY };
      dragStartBlock.current = blockEl;
      lastHoveredBlock.current = null;
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !dragStartPoint.current || !dragStartBlock.current) return;
      if (dragRafId.current !== null) cancelAnimationFrame(dragRafId.current);
      dragRafId.current = requestAnimationFrame(() => {
        dragRafId.current = null;
        if (!isDragging.current || !dragStartPoint.current || !dragStartBlock.current) return;

        const deltaY = Math.abs(e.clientY - dragStartPoint.current.y);

        if (!isBlockSelectionMode.current) {
          const blockRect = dragStartBlock.current.getBoundingClientRect();
          const hasExitedBlock = e.clientY < blockRect.top || e.clientY > blockRect.bottom;
          if (hasExitedBlock && deltaY > 5) {
            isBlockSelectionMode.current = true;
            window.getSelection()?.removeAllRanges();
            // Blur any active editor
            const activeEl = document.activeElement as HTMLElement | null;
            if (activeEl && rootEl.contains(activeEl)) {
              activeEl.blur();
            }
            useEditorFocusStore.getState().blurBlock(useEditorFocusStore.getState().activeBlockId ?? '');

            const startBlockId = dragStartBlock.current.getAttribute('data-block-id');
            if (startBlockId) {
              clearSelection();
              selectSingle(startBlockId);
              setDragging(true);
            }
          }
        }

        if (isBlockSelectionMode.current) {
          const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
          const hoveredBlock = target?.closest('[data-block-id]') as HTMLElement | null;
          if (hoveredBlock && !hoveredBlock.hasAttribute('data-ghost')) {
            const hoveredBlockId = hoveredBlock.getAttribute('data-block-id');
            if (hoveredBlockId && hoveredBlockId !== lastHoveredBlock.current) {
              lastHoveredBlock.current = hoveredBlockId;
              if (!selectedIds.has(hoveredBlockId)) {
                // Add to selection (drag selection accumulates)
                const next = new Set(selectedIds);
                next.add(hoveredBlockId);
                setSelectedIds([...next]);
              }
            }
          }
        }
      });
    };

    const handleMouseUp = () => {
      if (!isDragging.current) return;
      if (isBlockSelectionMode.current && selectedIds.size > 0) {
        justCompletedDrag.current = true;
        requestAnimationFrame(() => {
          justCompletedDrag.current = false;
        });
      }
      isDragging.current = false;
      isBlockSelectionMode.current = false;
      dragStartPoint.current = null;
      dragStartBlock.current = null;
      lastHoveredBlock.current = null;
      setDragging(false);
    };

    // ── Document click: clear selection when clicking outside ──
    const handleDocumentMouseDown = (e: MouseEvent) => {
      if (selectedIds.size === 0) return;
      const target = e.target as HTMLElement;
      const clickedBlock = target.closest('[data-block-id]') as HTMLElement | null;
      if (clickedBlock) {
        const blockId = clickedBlock.getAttribute('data-block-id');
        if (blockId && selectedIds.has(blockId)) return;
      }
      clearSelection();
    };

    // ── Keyboard: Escape ───────────────────────────────────────
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      const isFocusProtected = () => {
        const activeEl = document.activeElement as HTMLElement | null;
        if (!activeEl) return false;
        if (rootEl.contains(activeEl)) return true;
        if (activeEl.closest('[role="dialog"]') || activeEl.closest('[role="menu"]')) return true;
        if (isInsideEditorCompanion(activeEl)) return true;
        return false;
      };

      // Escape: clear selection, or if editor focused, select current block
      if (e.key === 'Escape') {
        if (selectedIds.size > 0) {
          e.preventDefault();
          clearSelection();
          return;
        }
        const activeBlockId = useEditorFocusStore.getState().activeBlockId;
        if (activeBlockId) {
          e.preventDefault();
          // Blur editor and select the block
          const activeEl = document.activeElement as HTMLElement | null;
          if (activeEl && rootEl.contains(activeEl)) {
            activeEl.blur();
          }
          useEditorFocusStore.getState().blurBlock(activeBlockId);
          selectSingle(activeBlockId);
        }
        return;
      }

      // Enter on selected block (editor not focused): create a child block as the first child
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && selectedIds.size > 0) {
        if (isFocusProtected()) return;

        e.preventDefault();
        const anchor = anchorId || [...selectedIds][0];
        if (!anchor) return;

        const newBlockId = generateUUID();
        await getUndoEngine().applyIntent({
          type: 'create_block',
          parentId: anchor,
          afterBlockId: null,
          blockId: newBlockId,
          contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
        });
        getRuntimeEventBus().flushEvents();
        clearSelection();
        useEditorFocusStore.getState().setPendingFocus(newBlockId);
        return;
      }

      // Shift+ArrowUp / Shift+ArrowDown: extend selection
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.shiftKey) {
        if (isFocusProtected()) return;
        const activeBlockId = useEditorFocusStore.getState().activeBlockId;
        const anchor = anchorId || activeBlockId;
        if (!anchor) return;
        const siblings = getSiblingIds(anchor);
        const currentFocus = useBlockSelectionStore.getState().focusId || anchor;
        const currentIdx = siblings.indexOf(currentFocus);
        if (currentIdx === -1) return;

        e.preventDefault();
        let newFocusIdx: number;
        if (e.key === 'ArrowUp') {
          newFocusIdx = Math.max(0, currentIdx - 1);
        } else {
          newFocusIdx = Math.min(siblings.length - 1, currentIdx + 1);
        }
        const newFocusId = siblings[newFocusIdx];
        if (newFocusId === currentFocus) return;

        // If no selection yet, start from anchor
        if (selectedIds.size === 0) {
          selectSingle(anchor);
        }
        extendTo(newFocusId, siblings);
        return;
      }

      // ArrowLeft / ArrowRight: if blocks selected, clear and focus editor
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.shiftKey) {
        if (isFocusProtected()) return;
        if (selectedIds.size === 0) return;
        e.preventDefault();
        const blockIdToFocus = anchorId || [...selectedIds][0];
        clearSelection();
        if (blockIdToFocus) {
          useEditorFocusStore.getState().focusBlock(blockIdToFocus);
        }
        return;
      }

      // Delete / Backspace: delete selected blocks when editor not focused
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0) {
        if (isFocusProtected()) return;

        e.preventDefault();
        flushAllContentSaves();
        const ids = [...selectedIds];
        clearSelection();
        await getUndoEngine().applyIntent({
          type: 'batch',
          intents: ids.map((blockId) => ({ type: 'delete_block' as const, blockId })),
        });
        getRuntimeEventBus().flushEvents();
        return;
      }

      // Alt+Shift+ArrowUp / Alt+Shift+ArrowDown: move selected blocks
      if (e.altKey && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        if (isFocusProtected()) return;
        if (selectedIds.size === 0) return;
        e.preventDefault();
        const runtime = getOperationRuntime();
        const blockIdSet = new Set(selectedIds);
        const allSelectedIds = [...selectedIds];
        const topLevelIds = allSelectedIds.filter((id) => {
          const n = getNode(runtime, id);
          return n && (!n.parentId || !blockIdSet.has(n.parentId));
        });
        flushAllContentSaves();
        if (e.key === 'ArrowUp') {
          await getUndoEngine().applyIntent({
            type: 'batch',
            intents: topLevelIds.map((blockId) => ({ type: 'move_up' as const, blockId })),
          });
        } else {
          await getUndoEngine().applyIntent({
            type: 'batch',
            intents: topLevelIds.reverse().map((blockId) => ({ type: 'move_down' as const, blockId })),
          });
        }
        getRuntimeEventBus().flushEvents();
        return;
      }

      // Document-level Ctrl+C: copy selected blocks when editor blurred
      const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
      const isMod = isMac ? e.metaKey : e.ctrlKey;
      if (isMod && e.key.toLowerCase() === 'c' && !e.shiftKey && !e.altKey) {
        if (selectedIds.size === 0) return;
        if (isFocusProtected()) return;
        e.preventDefault();
        const runtime = getOperationRuntime();
        copyRuntimeBlocksToClipboard([...selectedIds], runtime)
          .then((data) => useClipboardStore.getState().setCopied(data))
          .catch(console.error);
        return;
      }

      // Document-level Ctrl+V: paste after selected blocks when editor blurred
      if (isMod && e.key.toLowerCase() === 'v' && !e.shiftKey && !e.altKey) {
        if (selectedIds.size === 0) return;
        if (isFocusProtected()) return;

        const runtime = getOperationRuntime();
        const blockIdSet = new Set(selectedIds);
        const topLevelIds = [...selectedIds].filter((id) => {
          const n = getNode(runtime, id);
          return n && (!n.parentId || !blockIdSet.has(n.parentId));
        });
        if (topLevelIds.length === 0) return;
        const lastTopLevelId = topLevelIds[topLevelIds.length - 1];

        const { mode, copiedBlocks } = useClipboardStore.getState();
        if (mode === 'blocks' && copiedBlocks) {
          e.preventDefault();
          await pasteBlocksAfterBlock(copiedBlocks, lastTopLevelId);
          return;
        }

        e.preventDefault();
        navigator.clipboard
          .readText()
          .then(async (text) => {
            const blockData = tryParseInternalFormat(text);
            if (blockData) {
              await pasteBlocksAfterBlock(blockData, lastTopLevelId);
            }
          })
          .catch(() => {
            // Clipboard access denied — silently ignore
          });
      }
    };

    rootEl.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mousedown', handleDocumentMouseDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      rootEl.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousedown', handleDocumentMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
      if (dragRafId.current !== null) {
        cancelAnimationFrame(dragRafId.current);
        dragRafId.current = null;
      }
    };
  }, [containerRef, readOnly, selectedIds, anchorId, clearSelection, selectSingle, extendTo, setSelectedIds, setDragging, blockIds]);
}
