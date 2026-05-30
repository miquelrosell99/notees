/**
 * editorFocusStore — Centralized focus state machine for the block-level editor.
 *
 * Replaces scattered focus logic in BlurOnClickOutsidePlugin, BlockPlugin,
 * EmptyClickPlugin, and TriggerPopup with a single source of truth.
 */

import { create } from 'zustand';

// ─── Types ────────────────────────────────────────────────────────

interface EditorFocusState {
  /** The block ID whose InlineEditor currently has focus, or null. */
  activeBlockId: string | null;

  /** True when any popup (trigger, context menu, etc.) is open. */
  popupOpen: boolean;

  /** Block ID that should receive focus on next render cycle. */
  pendingFocusBlockId: string | null;

  /** Focus a specific block. Clears pending focus if it matches. */
  focusBlock: (blockId: string) => void;

  /** Blur the active block, but only if it matches and no popup is open. */
  blurBlock: (blockId: string) => void;

  /** Set pending focus (used after split/merge/create to focus a new block). */
  setPendingFocus: (blockId: string | null) => void;

  /** Mark that a popup has opened. Prevents blur-on-outside. */
  openPopup: () => void;

  /** Mark that a popup has closed. */
  closePopup: () => void;

  /** Move focus to the next block in a list (called by keyboard nav). */
  focusNextBlock: (blockIds: string[]) => void;

  /** Move focus to the previous block in a list. */
  focusPreviousBlock: (blockIds: string[]) => void;
}

// ─── Store ────────────────────────────────────────────────────────

export const useEditorFocusStore = create<EditorFocusState>((set, get) => ({
  activeBlockId: null,
  popupOpen: false,
  pendingFocusBlockId: null,

  focusBlock: (blockId: string) =>
    set((state) => ({
      activeBlockId: blockId,
      pendingFocusBlockId:
        state.pendingFocusBlockId === blockId ? null : state.pendingFocusBlockId,
    })),

  blurBlock: (blockId: string) =>
    set((state) => {
      if (state.activeBlockId !== blockId) return state; // Another block took focus
      if (state.popupOpen) return state; // Do not blur while popup is open
      return { activeBlockId: null, pendingFocusBlockId: null };
    }),

  setPendingFocus: (blockId: string | null) => set({ pendingFocusBlockId: blockId }),

  openPopup: () => set({ popupOpen: true }),

  closePopup: () => set({ popupOpen: false }),

  focusNextBlock: (blockIds: string[]) => {
    const { activeBlockId } = get();
    if (!activeBlockId) return;
    const idx = blockIds.indexOf(activeBlockId);
    if (idx >= 0 && idx < blockIds.length - 1) {
      set({ activeBlockId: blockIds[idx + 1], pendingFocusBlockId: blockIds[idx + 1] });
    }
  },

  focusPreviousBlock: (blockIds: string[]) => {
    const { activeBlockId } = get();
    if (!activeBlockId) return;
    const idx = blockIds.indexOf(activeBlockId);
    if (idx > 0) {
      set({ activeBlockId: blockIds[idx - 1], pendingFocusBlockId: blockIds[idx - 1] });
    }
  },
}));
