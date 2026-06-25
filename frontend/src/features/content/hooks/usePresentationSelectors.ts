import { usePresentationStore } from '@/stores/presentationStore';
import { useShallow } from 'zustand/react/shallow';

export const usePresentationState = () =>
  usePresentationStore(
    useShallow((s) => ({
      isOpen: s.isOpen,
      nodeUuid: s.nodeUuid,
      closePresentation: s.closePresentation,
    })),
  );
