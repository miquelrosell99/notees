/**
 * BlockSelectionStore — Centralized block selection state for the
 * block-level editor architecture (per-block Lexical instances).
 *
 * Replaces the old Lexical-based selection plugins
 * (BlockDragSelectionPlugin, KeyboardSelectionPlugin).
 */

import { create } from 'zustand';

interface BlockSelectionState {
  /** Set of selected block UUIDs */
  selectedIds: Set<string>;
  /** Anchor block for keyboard shift-selection */
  anchorId: string | null;
  /** Focus block for keyboard shift-selection */
  focusId: string | null;
  /** True while mouse drag-selection is in progress */
  isDragging: boolean;
  /** Replace selection with a single block */
  selectSingle(blockId: string): void;
  /** Toggle a block in the selection */
  toggleBlock(blockId: string): void;
  /** Extend selection from anchor to focus (sibling range) */
  extendTo(focusBlockId: string, siblingIds: string[]): void;
  /** Clear all selection */
  clearSelection(): void;
  /** Set raw selected IDs */
  setSelectedIds(ids: string[]): void;
  /** Start / end drag selection */
  setDragging(active: boolean): void;
}

export const useBlockSelectionStore = create<BlockSelectionState>((set) => ({
  selectedIds: new Set(),
  anchorId: null,
  focusId: null,
  isDragging: false,

  selectSingle(blockId) {
    set({ selectedIds: new Set([blockId]), anchorId: blockId, focusId: blockId });
  },

  toggleBlock(blockId) {
    set((state) => {
      const next = new Set(state.selectedIds);
      if (next.has(blockId)) {
        next.delete(blockId);
      } else {
        next.add(blockId);
      }
      return { selectedIds: next, anchorId: blockId, focusId: blockId };
    });
  },

  extendTo(focusBlockId, siblingIds) {
    set((state) => {
      const anchorId = state.anchorId;
      if (!anchorId) {
        return { selectedIds: new Set([focusBlockId]), anchorId: focusBlockId, focusId: focusBlockId };
      }
      const anchorIdx = siblingIds.indexOf(anchorId);
      const focusIdx = siblingIds.indexOf(focusBlockId);
      if (anchorIdx === -1 || focusIdx === -1) return state;
      const start = Math.min(anchorIdx, focusIdx);
      const end = Math.max(anchorIdx, focusIdx);
      const next = new Set<string>();
      for (let i = start; i <= end; i++) {
        next.add(siblingIds[i]);
      }
      return { selectedIds: next, focusId: focusBlockId };
    });
  },

  clearSelection() {
    set({ selectedIds: new Set(), anchorId: null, focusId: null });
  },

  setSelectedIds(ids) {
    set({ selectedIds: new Set(ids) });
  },

  setDragging(active) {
    set({ isDragging: active });
  },
}));
