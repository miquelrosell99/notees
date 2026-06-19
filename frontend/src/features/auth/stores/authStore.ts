/**
 * Authentication store using Zustand
 *
 * The access token is stored in an HTTPOnly cookie by the backend, so the
 * frontend only persists the user object here. Authentication state is derived
 * from the presence of the user and verified by /api/auth/me on app start.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User } from '@/types';
import * as authApi from '@/features/auth/api/auth';

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  /** True once the access token has been verified/refreshed against the backend. */
  authVerified: boolean;

  // Actions
  login: (email: string, password: string, rememberMe?: boolean) => Promise<void>;
  register: (email: string, password: string, name?: string, rememberMe?: boolean) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => void;
  setUser: (user: User | null) => void;
  setAuthVerified: (verified: boolean) => void;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
      authVerified: false,

      login: async (email: string, password: string, rememberMe: boolean = true) => {
        set({ isLoading: true, error: null });
        try {
          const response = await authApi.login({ email, password, remember_me: rememberMe });
          authApi.storeAuth(response);
          set({
            user: response.user,
            isAuthenticated: true,
            isLoading: false,
            authVerified: true,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Login failed';
          set({ error: message, isLoading: false });
          throw error;
        }
      },

      register: async (email: string, password: string, name?: string, rememberMe: boolean = true) => {
        set({ isLoading: true, error: null });
        try {
          const response = await authApi.register({ email, password, name, remember_me: rememberMe });
          authApi.storeAuth(response);
          set({
            user: response.user,
            isAuthenticated: true,
            isLoading: false,
            authVerified: true,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Registration failed';
          set({ error: message, isLoading: false });
          throw error;
        }
      },

      changePassword: async (currentPassword: string, newPassword: string) => {
        await authApi.changePassword({ current_password: currentPassword, new_password: newPassword });
      },

      logout: () => {
        authApi.logout();
        set({
          user: null,
          isAuthenticated: false,
          authVerified: false,
        });
      },

      setUser: (user: User | null) => {
        set({ user, isAuthenticated: !!user });
      },

      setAuthVerified: (verified: boolean) => {
        set({ authVerified: verified });
      },

      clearError: () => {
        set({ error: null });
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({
        user: state.user,
      }),
    }
  )
);
