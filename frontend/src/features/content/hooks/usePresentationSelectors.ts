import { usePresentationStore } from '@/stores/presentationStore';
import { useShallow } from 'zustand/react/shallow';

export const usePresentationState = () =>
  usePresentationStore(
    useShallow((s) => ({
      isOpen: s.isOpen,
      nodeId: s.nodeId,
      closePresentation: s.closePresentation,
    })),
  );
