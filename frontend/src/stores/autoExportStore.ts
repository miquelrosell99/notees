/**
 * Auto-export status store
 *
 * Tracks live export state (idle/exporting/done) for the sync indicator UI.
 */
import { create } from 'zustand';

export type ExportStatus = 'idle' | 'exporting' | 'done' | 'error';

interface AutoExportState {
  status: ExportStatus;
  lastExportTime: number | null;
  currentPageUuid: string | null;
  errorMessage: string | null;

  // Actions
  setExporting: (pageUuid: string) => void;
  setDone: () => void;
  setError: (message: string) => void;
  setIdle: () => void;
}

const DONE_VISIBLE_MS = 2000;

export const useAutoExportStore = create<AutoExportState>()((set, get) => ({
  status: 'idle',
  lastExportTime: null,
  currentPageUuid: null,
  errorMessage: null,

  setExporting: (pageUuid) => {
    set({ status: 'exporting', currentPageUuid: pageUuid, errorMessage: null });
  },

  setDone: () => {
    set({ status: 'done', lastExportTime: Date.now(), currentPageUuid: null, errorMessage: null });
    // Auto-clear the done state after a short delay so the checkmark doesn't linger forever
    setTimeout(() => {
      const state = get();
      if (state.status === 'done' && state.lastExportTime && Date.now() - state.lastExportTime >= DONE_VISIBLE_MS) {
        set({ status: 'idle' });
      }
    }, DONE_VISIBLE_MS);
  },

  setError: (message) => {
    set({ status: 'error', errorMessage: message, currentPageUuid: null });
  },

  setIdle: () => {
    set({ status: 'idle', currentPageUuid: null, errorMessage: null });
  },
}));
