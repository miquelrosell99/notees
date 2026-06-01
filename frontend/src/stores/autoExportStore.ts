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
  currentNodeUuid: string | null;
  errorMessage: string | null;

  // Actions
  setExporting: (nodeUuid: string) => void;
  setDone: () => void;
  setError: (message: string) => void;
  setIdle: () => void;
}

const DONE_VISIBLE_MS = 2000;

export const useAutoExportStore = create<AutoExportState>()((set, get) => ({
  status: 'idle',
  lastExportTime: null,
  currentNodeUuid: null,
  errorMessage: null,

  setExporting: (nodeUuid) => {
    set({ status: 'exporting', currentNodeUuid: nodeUuid, errorMessage: null });
  },

  setDone: () => {
    set({ status: 'done', lastExportTime: Date.now(), currentNodeUuid: null, errorMessage: null });
    // Auto-clear the done state after a short delay so the checkmark doesn't linger forever
    setTimeout(() => {
      const state = get();
      if (state.status === 'done' && state.lastExportTime && Date.now() - state.lastExportTime >= DONE_VISIBLE_MS) {
        set({ status: 'idle' });
      }
    }, DONE_VISIBLE_MS);
  },

  setError: (message) => {
    set({ status: 'error', errorMessage: message, currentNodeUuid: null });
  },

  setIdle: () => {
    set({ status: 'idle', currentNodeUuid: null, errorMessage: null });
  },
}));
