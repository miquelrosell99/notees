import { useAuthStore } from '@/stores';
import { useShallow } from 'zustand/react/shallow';

export const useAuthUser = () => useAuthStore((s) => s.user);

export const useAuthActions = () =>
  useAuthStore(
    useShallow((s) => ({
      logout: s.logout,
      setUser: s.setUser,
      changePassword: s.changePassword,
    })),
  );
