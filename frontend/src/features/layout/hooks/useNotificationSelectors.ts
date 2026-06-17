import { useNotificationStore } from '@/stores';
import { useShallow } from 'zustand/react/shallow';

export const useNotifyActions = () =>
  useNotificationStore(
    useShallow((s) => ({
      notifyError: s.error,
      notifyWarning: s.warning,
      notifySuccess: s.success,
    })),
  );
