/**
 * InputContext — Centralized input modality tracking.
 *
 * Prevents editor-level keyboard shortcuts from firing when the user
 * is interacting with popups, modals, or drag operations.
 */

import { create } from 'zustand';

interface InputContextState {
  /** True when any modal/dialog is open */
  modalOpen: boolean;
  /** True when any popup/suggestion menu is open */
  popupOpen: boolean;
  /** True when block drag-selection is active */
  dragActive: boolean;
  /** Increment/decrement modal counter so nested modals work */
  modalCount: number;
  /** Increment/decrement popup counter so nested popups work */
  popupCount: number;
  enterModal(): void;
  leaveModal(): void;
  enterPopup(): void;
  leavePopup(): void;
  setDragActive(active: boolean): void;
  /** Convenience: true if ANY overlay is consuming input */
  readonly isOverlayOpen: boolean;
}

export const useInputContext = create<InputContextState>((set, get) => ({
  modalOpen: false,
  popupOpen: false,
  dragActive: false,
  modalCount: 0,
  popupCount: 0,
  enterModal: () => {
    const next = get().modalCount + 1;
    set({ modalCount: next, modalOpen: next > 0 });
  },
  leaveModal: () => {
    const next = Math.max(0, get().modalCount - 1);
    set({ modalCount: next, modalOpen: next > 0 });
  },
  enterPopup: () => {
    const next = get().popupCount + 1;
    set({ popupCount: next, popupOpen: next > 0 });
  },
  leavePopup: () => {
    const next = Math.max(0, get().popupCount - 1);
    set({ popupCount: next, popupOpen: next > 0 });
  },
  setDragActive: (active) => set({ dragActive: active }),
  get isOverlayOpen() {
    const s = get();
    return s.modalOpen || s.popupOpen || s.dragActive;
  },
}));
