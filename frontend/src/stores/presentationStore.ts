import { create } from 'zustand';

interface PresentationState {
  isOpen: boolean;
  nodeId: number | null;
  openPresentation: (nodeId: number) => void;
  closePresentation: () => void;
}

export const usePresentationStore = create<PresentationState>((set) => ({
  isOpen: false,
  nodeId: null,
  openPresentation: (nodeId) => set({ isOpen: true, nodeId }),
  closePresentation: () => set({ isOpen: false, nodeId: null }),
}));
