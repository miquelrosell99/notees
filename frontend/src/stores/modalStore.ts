/**
 * Modal store — manages all overlay/modal visibility flags.
 *
 * Extracted from the legacy god-object appStore to isolate modal
 * state changes from navigation and display-preference re-renders.
 */
import { create } from 'zustand';

interface ModalState {
  isCalendarOpen: boolean;
  isQuickAddOpen: boolean;
  isCommandPaletteOpen: boolean;
  isImportDataModalOpen: boolean;
  isImportLogseqModalOpen: boolean;
  isImportLogseqFolderModalOpen: boolean;
  isImportMarkdownModalOpen: boolean;
  isExportPageModalOpen: boolean;
  isRebuildLinksModalOpen: boolean;
  isFixRawLinksModalOpen: boolean;
  isMergePagesModalOpen: boolean;
  showWorkspaceManager: boolean;
  isMinimapOpen: boolean;
  isScratchpadOpen: boolean;
  isCreateWithUuidModalOpen: boolean;
  createWithUuidPrefill: string | null;

  setCalendarOpen: (open: boolean) => void;
  toggleCalendar: () => void;
  setQuickAddOpen: (open: boolean) => void;
  toggleQuickAdd: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  toggleCommandPalette: () => void;
  setImportDataModalOpen: (open: boolean) => void;
  setImportLogseqModalOpen: (open: boolean) => void;
  setImportLogseqFolderModalOpen: (open: boolean) => void;
  setImportMarkdownModalOpen: (open: boolean) => void;
  setExportPageModalOpen: (open: boolean) => void;
  setRebuildLinksModalOpen: (open: boolean) => void;
  setFixRawLinksModalOpen: (open: boolean) => void;
  setMergePagesModalOpen: (open: boolean) => void;
  setShowWorkspaceManager: (show: boolean) => void;
  toggleMinimap: () => void;
  setMinimapOpen: (open: boolean) => void;
  toggleScratchpad: () => void;
  setScratchpadOpen: (open: boolean) => void;
  setCreateWithUuidModalOpen: (open: boolean, prefill?: string | null) => void;
}

export const useModalStore = create<ModalState>()((set) => ({
  isCalendarOpen: false,
  isQuickAddOpen: false,
  isCommandPaletteOpen: false,
  isImportDataModalOpen: false,
  isImportLogseqModalOpen: false,
  isImportLogseqFolderModalOpen: false,
  isImportMarkdownModalOpen: false,
  isExportPageModalOpen: false,
  isRebuildLinksModalOpen: false,
  isFixRawLinksModalOpen: false,
  isMergePagesModalOpen: false,
  showWorkspaceManager: false,
  isMinimapOpen: false,
  isScratchpadOpen: false,
  isCreateWithUuidModalOpen: false,
  createWithUuidPrefill: null,

  setCalendarOpen: (open) => set({ isCalendarOpen: open }),
  toggleCalendar: () => set((s) => ({ isCalendarOpen: !s.isCalendarOpen })),
  setQuickAddOpen: (open) => set({ isQuickAddOpen: open }),
  toggleQuickAdd: () => set((s) => ({ isQuickAddOpen: !s.isQuickAddOpen })),
  setCommandPaletteOpen: (open) => set({ isCommandPaletteOpen: open }),
  toggleCommandPalette: () => set((s) => ({ isCommandPaletteOpen: !s.isCommandPaletteOpen })),
  setImportDataModalOpen: (open) => set({ isImportDataModalOpen: open }),
  setImportLogseqModalOpen: (open) => set({ isImportLogseqModalOpen: open }),
  setImportLogseqFolderModalOpen: (open) => set({ isImportLogseqFolderModalOpen: open }),
  setImportMarkdownModalOpen: (open) => set({ isImportMarkdownModalOpen: open }),
  setExportPageModalOpen: (open) => set({ isExportPageModalOpen: open }),
  setRebuildLinksModalOpen: (open) => set({ isRebuildLinksModalOpen: open }),
  setFixRawLinksModalOpen: (open) => set({ isFixRawLinksModalOpen: open }),
  setMergePagesModalOpen: (open) => set({ isMergePagesModalOpen: open }),
  setShowWorkspaceManager: (show) => set({ showWorkspaceManager: show }),
  toggleMinimap: () => set((s) => ({ isMinimapOpen: !s.isMinimapOpen })),
  setMinimapOpen: (open) => set({ isMinimapOpen: open }),
  toggleScratchpad: () => set((s) => ({ isScratchpadOpen: !s.isScratchpadOpen })),
  setScratchpadOpen: (open) => set({ isScratchpadOpen: open }),
  setCreateWithUuidModalOpen: (open, prefill = null) => set({ isCreateWithUuidModalOpen: open, createWithUuidPrefill: prefill }),
}));
