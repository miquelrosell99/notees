import { useNavigationStore } from '@/stores';
import { useShallow } from 'zustand/react/shallow';

export const useTabActions = () =>
  useNavigationStore(
    useShallow((s) => ({
      activateTab: s.activateTab,
      closeTab: s.closeTab,
      reorderTabs: s.reorderTabs,
      pinTab: s.pinTab,
      unpinTab: s.unpinTab,
    })),
  );
