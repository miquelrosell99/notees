import { useNavigationStore } from '@/stores';
import { useShallow } from 'zustand/react/shallow';

export const useCurrentNodeUuid = () => useNavigationStore((s) => s.currentNodeUuid);
export const useOpenNodeAction = () => useNavigationStore((s) => s.openNode);
export const useOpenLocalGraphAction = () => useNavigationStore((s) => s.openLocalGraph);

export const useSidebarCards = () => useNavigationStore((s) => s.sidebarCards);
export const useAddSidebarCardAction = () => useNavigationStore((s) => s.addSidebarCard);
export const useFlashSidebarCardAction = () => useNavigationStore((s) => s.flashSidebarCard);

export const useOpenNode = () => useNavigationStore((s) => s.openNode);

export const useCollectionNavigation = () =>
  useNavigationStore(
    useShallow((s) => ({
      openNode: s.openNode,
      closeNodeCollection: s.closeNodeCollection,
      addSidebarCard: s.addSidebarCard,
    })),
  );
