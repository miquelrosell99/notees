/**
 * SelectionPlugin — Handles multi-block selection, box select,
 * and recursive child selection through NodeGraphRuntime.
 *
 * Selection behaviors:
 * - Box select: selects all nodes intersected by the selection rect
 * - Parent select: recursively selects children via runtime query
 * - Shift+Arrow: extends selection across blocks
 */

import { useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
} from 'lexical';
import { $isBlockNode } from '../nodes/BlockNode';
import { findParentNodeBlock } from '../utils/selectionUtils';

export interface SelectionPluginProps {
  editorId: string;
  /** Called when selection changes */
  onSelectionChange?: (selectedBlockIds: string[]) => void;
  /** Enable box select */
  enableBoxSelect?: boolean;
}

export function SelectionPlugin({
  editorId: _editorId,
  onSelectionChange,
  enableBoxSelect = true,
}: SelectionPluginProps): null {
  const [editor] = useLexicalComposerContext();
  const selectedBlockIds = useRef<Set<string>>(new Set());
  const isBoxSelecting = useRef(false);
  const boxStartPoint = useRef<{ x: number; y: number } | null>(null);
  const boxElement = useRef<HTMLDivElement | null>(null);

  // ─── Track selection changes ───────────────────────────────

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        const newSelectedIds = new Set<string>();

        if ($isRangeSelection(selection)) {
          // Find which blocks the selection spans
          const anchorNode = selection.anchor.getNode();
          const focusNode = selection.focus.getNode();

          const anchorBlock = findParentNodeBlock(anchorNode);
          const focusBlock = findParentNodeBlock(focusNode);

          if (anchorBlock) newSelectedIds.add(anchorBlock.getBlockId());
          if (focusBlock) newSelectedIds.add(focusBlock.getBlockId());

          // If spanning multiple blocks, include all between
          if (anchorBlock && focusBlock && anchorBlock !== focusBlock) {
            const root = $getRoot();
            const children = root.getChildren();
            let inRange = false;
            for (const child of children) {
              if ($isBlockNode(child)) {
                if (child === anchorBlock || child === focusBlock) {
                  newSelectedIds.add(child.getBlockId());
                  if (inRange) break;
                  inRange = true;
                } else if (inRange) {
                  newSelectedIds.add(child.getBlockId());
                }
              }
            }
          }
        }

        // Check if selection changed
        if (!setsEqual(selectedBlockIds.current, newSelectedIds)) {
          selectedBlockIds.current = newSelectedIds;
          onSelectionChange?.([...newSelectedIds]);
        }
      });
    });
  }, [editor, onSelectionChange]);

  // ─── Box select ────────────────────────────────────────────

  useEffect(() => {
    if (!enableBoxSelect) return;

    const rootEl = editor.getRootElement();
    if (!rootEl) return;

    const parentEl = rootEl.parentElement;
    if (!parentEl) return;

    const handleMouseDown = (e: MouseEvent) => {
      // Only start box select on middle-click or ctrl+click on empty space
      if (e.button !== 0 || !e.ctrlKey) return;

      const target = e.target as HTMLElement;
      if (target.closest('[data-block-id]')) return; // Don't box-select from within a block

      isBoxSelecting.current = true;
      boxStartPoint.current = { x: e.clientX, y: e.clientY };

      // Create visual box
      const box = document.createElement('div');
      box.className = 'selection-box';
      box.style.position = 'fixed';
      box.style.border = '1px solid var(--color-accent, #3b82f6)';
      box.style.background = 'rgba(59, 130, 246, 0.1)';
      box.style.pointerEvents = 'none';
      box.style.zIndex = '1000';
      document.body.appendChild(box);
      boxElement.current = box;
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isBoxSelecting.current || !boxStartPoint.current || !boxElement.current) return;

      const { x: sx, y: sy } = boxStartPoint.current;
      const ex = e.clientX;
      const ey = e.clientY;

      const left = Math.min(sx, ex);
      const top = Math.min(sy, ey);
      const width = Math.abs(ex - sx);
      const height = Math.abs(ey - sy);

      boxElement.current.style.left = `${left}px`;
      boxElement.current.style.top = `${top}px`;
      boxElement.current.style.width = `${width}px`;
      boxElement.current.style.height = `${height}px`;

      // Find intersecting blocks
      const boxRect = { left, top, right: left + width, bottom: top + height };
      const intersecting = new Set<string>();

      rootEl.querySelectorAll('[data-block-id]').forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rectsIntersect(boxRect, rect)) {
          const blockId = el.getAttribute('data-block-id');
          if (blockId) intersecting.add(blockId);
        }
      });

      selectedBlockIds.current = intersecting;
      onSelectionChange?.([...intersecting]);
    };

    const handleMouseUp = () => {
      if (!isBoxSelecting.current) return;
      isBoxSelecting.current = false;
      boxStartPoint.current = null;

      if (boxElement.current) {
        boxElement.current.remove();
        boxElement.current = null;
      }
    };

    parentEl.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      parentEl.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      if (boxElement.current) {
        boxElement.current.remove();
      }
    };
  }, [editor, enableBoxSelect, onSelectionChange]);

  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

function rectsIntersect(
  a: { left: number; top: number; right: number; bottom: number },
  b: DOMRect,
): boolean {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}
