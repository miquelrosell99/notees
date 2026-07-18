/**
 * Modal store — manages all overlay/modal visibility flags.
 *
 * Extracted from the legacy god-object appStore to isolate modal
 * state changes from navigation and display-preference re-renders.
 */
import { create } from 'zustand';

interface ModalState {
  isCalendarOpen: boolean;
  isTasksPopupOpen: boolean;
  isFilterBuilderOpen: boolean;

  isCommandPaletteOpen: boolean;
  isImportDataModalOpen: boolean;
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
  isShareModalOpen: boolean;
  isAutoExportProgressModalOpen: boolean;
  isWorkspaceExportModalOpen: boolean;
  workspaceExportTargetUuid: string | null;
  isConflictResolutionModalOpen: boolean;
  conflictResolutionNodeUuid: string | null;

  setCalendarOpen: (open: boolean) => void;
  toggleCalendar: () => void;
  setTasksPopupOpen: (open: boolean) => void;
  toggleTasksPopup: () => void;
  setFilterBuilderOpen: (open: boolean) => void;

  setCommandPaletteOpen: (open: boolean) => void;
  toggleCommandPalette: () => void;
  setImportDataModalOpen: (open: boolean) => void;
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
  setShareModalOpen: (open: boolean) => void;
  setAutoExportProgressModalOpen: (open: boolean) => void;
  setWorkspaceExportModalOpen: (open: boolean, targetUuid?: string | null) => void;
  setConflictResolutionModalOpen: (open: boolean, nodeUuid?: string | null) => void;
}

export const useModalStore = create<ModalState>()((set) => ({
  isCalendarOpen: false,
  isTasksPopupOpen: false,
  isFilterBuilderOpen: false,

  isCommandPaletteOpen: false,
  isImportDataModalOpen: false,
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
  isShareModalOpen: false,
  isAutoExportProgressModalOpen: false,
  isWorkspaceExportModalOpen: false,
  workspaceExportTargetUuid: null,
  isConflictResolutionModalOpen: false,
  conflictResolutionNodeUuid: null,

  setCalendarOpen: (open) => set({ isCalendarOpen: open }),
  toggleCalendar: () => set((s) => ({ isCalendarOpen: !s.isCalendarOpen })),
  setTasksPopupOpen: (open) => set({ isTasksPopupOpen: open }),
  toggleTasksPopup: () => set((s) => ({ isTasksPopupOpen: !s.isTasksPopupOpen })),
  setFilterBuilderOpen: (open) => set({ isFilterBuilderOpen: open }),

  setCommandPaletteOpen: (open) => set({ isCommandPaletteOpen: open }),
  toggleCommandPalette: () => set((s) => ({ isCommandPaletteOpen: !s.isCommandPaletteOpen })),
  setImportDataModalOpen: (open) => set({ isImportDataModalOpen: open }),
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
  setShareModalOpen: (open) => set({ isShareModalOpen: open }),
  setAutoExportProgressModalOpen: (open) => set({ isAutoExportProgressModalOpen: open }),
  setWorkspaceExportModalOpen: (open, targetUuid = null) => set({ isWorkspaceExportModalOpen: open, workspaceExportTargetUuid: targetUuid }),
  setConflictResolutionModalOpen: (open, nodeUuid = null) => set({ isConflictResolutionModalOpen: open, conflictResolutionNodeUuid: nodeUuid }),
}));
