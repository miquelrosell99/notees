/**
 * InputContext — Centralized input modality tracking.
 *
 * Prevents editor-level keyboard shortcuts from firing when the user
 * is interacting with popups, modals, or drag operations.
 *
 * It also maintains an ordered stack of open overlay surfaces so that
 * a global Escape press can close the most recently opened surface
 * regardless of where DOM focus is.
 */

import { create } from 'zustand';

export type OverlaySurfaceType = 'modal' | 'popup';

export interface OverlaySurface {
  id: string;
  type: OverlaySurfaceType;
  close: () => void;
  /** Return true to consume Escape without closing the surface. */
  onEscape?: () => boolean | void;
}

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
  /** Ordered stack of open overlay surfaces (oldest → newest) */
  surfaceStack: OverlaySurface[];

  enterModal(): void;
  leaveModal(): void;
  enterPopup(): void;
  leavePopup(): void;
  setDragActive(active: boolean): void;

  /** Push a surface onto the stack and return its generated id. */
  pushSurface(surface: Omit<OverlaySurface, 'id'> & { id?: string }): string;
  /** Remove a surface from the stack by id. */
  removeSurface(id: string): void;
  /** Close the topmost surface. Returns true if Escape was consumed/acted on. */
  closeTopSurface(): boolean;

  /** Convenience: true if ANY overlay is consuming input */
  readonly isOverlayOpen: boolean;
}

function generateSurfaceId(): string {
  return `surface-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

export const useInputContext = create<InputContextState>((set, get) => ({
  modalOpen: false,
  popupOpen: false,
  dragActive: false,
  modalCount: 0,
  popupCount: 0,
  surfaceStack: [],

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

  pushSurface: (surface) => {
    const id = surface.id ?? generateSurfaceId();
    set((state) => ({
      surfaceStack: [...state.surfaceStack, { ...surface, id }],
    }));
    if (surface.type === 'modal') {
      get().enterModal();
    } else {
      get().enterPopup();
    }
    return id;
  },

  removeSurface: (id) => {
    const surface = get().surfaceStack.find((s) => s.id === id);
    if (!surface) return;
    set((state) => ({
      surfaceStack: state.surfaceStack.filter((s) => s.id !== id),
    }));
    if (surface.type === 'modal') {
      get().leaveModal();
    } else {
      get().leavePopup();
    }
  },

  closeTopSurface: () => {
    const stack = get().surfaceStack;
    const top = stack[stack.length - 1];
    if (!top) return false;

    if (top.onEscape) {
      const consumed = top.onEscape();
      if (consumed) return true;
    }

    top.close();
    get().removeSurface(top.id);
    return true;
  },

  get isOverlayOpen() {
    const s = get();
    return s.modalOpen || s.popupOpen || s.dragActive;
  },
}));
