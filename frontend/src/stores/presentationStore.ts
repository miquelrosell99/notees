import { create } from 'zustand';

interface PresentationState {
  isOpen: boolean;
  nodeUuid: string | null;
  openPresentation: (nodeUuid: string) => void;
  closePresentation: () => void;
}

export const usePresentationStore = create<PresentationState>((set) => ({
  isOpen: false,
  nodeUuid: null,
  openPresentation: (nodeUuid) => set({ isOpen: true, nodeUuid }),
  closePresentation: () => set({ isOpen: false, nodeUuid: null }),
}));
