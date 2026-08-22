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
import { scheduleProactiveRefresh, cancelProactiveRefresh, isApiError } from '@/api/client';
import { setUserData, clearUserData } from '@/utils/auth';
import { uuidv7 } from '@/core/uuid';

/**
 * Local-first split (Task 2): the well-known local workspace UUID, generated
 * once per browser profile and persisted alongside the session. It survives
 * logout so signing back in locally reopens the same workspace (and its
 * IndexedDB data).
 */
const LOCAL_WORKSPACE_UUID_KEY = 'notees.localWorkspaceUuid';

/**
 * The well-known local workspace UUID for this profile, creating and
 * persisting it on first use.
 */
export function getLocalWorkspaceUuid(): string {
  let uuid = localStorage.getItem(LOCAL_WORKSPACE_UUID_KEY);
  if (!uuid) {
    uuid = uuidv7();
    localStorage.setItem(LOCAL_WORKSPACE_UUID_KEY, uuid);
  }
  return uuid;
}

/**
 * The persisted local workspace UUID, or `null` when this profile never had a
 * local session. Unlike `getLocalWorkspaceUuid` this has no side effects —
 * used by the connect-later adoption check (local-first split, Task 6) to
 * decide whether a post-login adoption prompt applies.
 */
export function getExistingLocalWorkspaceUuid(): string | null {
  return localStorage.getItem(LOCAL_WORKSPACE_UUID_KEY);
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  /** True once the access token has been verified/refreshed against the backend. */
  authVerified: boolean;
  /** In-progress login-time 2FA challenge (verify or forced setup). */
  twoFactor: null | { preauth_token: string; purpose: 'verify' | 'setup' };
  /** One-time backup codes shown after enable/regenerate. */
  backupCodes: string[] | null;
  /** TOTP enrollment payload (QR + manual key) while setup is in progress. */
  setupData: null | { otpauth_uri: string; qr_svg: string; secret: string };

  // Actions
  login: (email: string, password: string, rememberMe?: boolean) => Promise<void>;
  /** Create a local, serverless session (local-first split). No network calls. */
  loginLocally: () => void;
  register: (email: string, password: string, name?: string, rememberMe?: boolean) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  verifyTwoFactor: (code: string) => Promise<void>;
  beginTwoFactorSetup: () => Promise<void>;
  confirmTwoFactorSetup: (code: string) => Promise<void>;
  cancelTwoFactor: () => void;
  clearBackupCodes: () => void;
  disableTwoFactor: (opts: { current_password?: string; code?: string }) => Promise<void>;
  regenerateBackupCodes: (code: string) => Promise<void>;
  logout: () => void;
  /** Clear local session state without calling the server. */
  clearSession: () => void;
  setUser: (user: User | null) => void;
  setAuthVerified: (verified: boolean) => void;
  clearError: () => void;
}

function extractDetail(data: unknown): string | null {
  if (data && typeof data === 'object' && 'detail' in data) {
    const detail = (data as { detail: unknown }).detail;
    if (typeof detail === 'string' && detail.trim()) return detail;
  }
  return null;
}

/**
 * Map an auth request failure to a safe, user-facing message.
 *
 * The 401 message is intentionally generic and never reveals whether the email
 * exists (prevents account enumeration). Rate limiting (429) and temporary
 * server-side verification outages (503) get distinct, actionable messages.
 */
function getAuthErrorMessage(error: unknown, fallback: string): string {
  if (isApiError(error) && error.response) {
    const { status, data } = error.response;
    const detail = extractDetail(data);
    if (status === 429) {
      return 'Too many sign-in attempts. Please wait a minute and try again.';
    }
    if (status === 503) {
      return detail ?? 'Sign-in is temporarily unavailable. Please try again shortly.';
    }
    if (status === 401) {
      return detail ?? 'Invalid email or password';
    }
    if (detail) return detail;
  }
  return error instanceof Error ? error.message : fallback;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
      authVerified: false,
      twoFactor: null,
      backupCodes: null,
      setupData: null,

      login: async (email: string, password: string, rememberMe: boolean = true) => {
        set({ isLoading: true, error: null });
        try {
          const response = await authApi.login({ email, password, remember_me: rememberMe });
          if (authApi.isTwoFactorRequired(response)) {
            set({
              twoFactor: {
                preauth_token: response.preauth_token,
                purpose: response.purpose,
              },
              isLoading: false,
              error: null,
            });
            return;
          }
          authApi.storeAuth(response);
          scheduleProactiveRefresh(response.access_token);
          set({
            user: response.user,
            isAuthenticated: true,
            isLoading: false,
            authVerified: true,
          });
        } catch (error) {
          const message = getAuthErrorMessage(error, 'Login failed');
          set({ error: message, isLoading: false });
          throw error;
        }
      },

      /**
       * Create a local, serverless session. The session is persisted exactly
       * like a server login (user object only), but there is no token, no
       * proactive refresh scheduling, and no `/auth/*` call. The local uuid
       * doubles as the op-log actor id.
       */
      loginLocally: () => {
        const user: User = {
          nodeUuid: uuidv7(),
          uuid: uuidv7(),
          email: 'local@local',
          name: 'Local user',
          surnames: null,
          profile_pic: null,
          role: 'user',
          is_active: true,
          totp_enabled: false,
          isLocal: true,
        };
        // Ensure the well-known local workspace exists alongside the session.
        getLocalWorkspaceUuid();
        setUserData(user);
        set({
          user,
          isAuthenticated: true,
          isLoading: false,
          error: null,
          authVerified: true,
          twoFactor: null,
          backupCodes: null,
          setupData: null,
        });
      },

      register: async (email: string, password: string, name?: string, rememberMe: boolean = true) => {
        set({ isLoading: true, error: null });
        try {
          const response = await authApi.register({ email, password, name, remember_me: rememberMe });
          authApi.storeAuth(response);
          scheduleProactiveRefresh(response.access_token);
          set({
            user: response.user,
            isAuthenticated: true,
            isLoading: false,
            authVerified: true,
          });
        } catch (error) {
          const message = getAuthErrorMessage(error, 'Registration failed');
          set({ error: message, isLoading: false });
          throw error;
        }
      },

      changePassword: async (currentPassword: string, newPassword: string) => {
        await authApi.changePassword({ current_password: currentPassword, new_password: newPassword });
      },

      verifyTwoFactor: async (code: string) => {
        const tf = get().twoFactor;
        if (!tf) return;
        set({ isLoading: true, error: null });
        try {
          const response = await authApi.totpVerify(tf.preauth_token, code);
          authApi.storeAuth(response);
          scheduleProactiveRefresh(response.access_token);
          set({
            user: response.user,
            isAuthenticated: true,
            isLoading: false,
            authVerified: true,
            twoFactor: null,
            error: null,
          });
        } catch (error) {
          const message = getAuthErrorMessage(error, 'Verification failed');
          set({ error: message, isLoading: false });
          throw error;
        }
      },

      beginTwoFactorSetup: async () => {
        const tf = get().twoFactor;
        const pre = tf?.purpose === 'setup' ? tf.preauth_token : undefined;
        set({ isLoading: true, error: null });
        try {
          const data = await authApi.totpSetup(pre);
          set({ setupData: data, isLoading: false });
        } catch (error) {
          const message = getAuthErrorMessage(error, 'Could not start two-factor setup');
          set({ error: message, isLoading: false });
          throw error;
        }
      },

      confirmTwoFactorSetup: async (code: string) => {
        const tf = get().twoFactor;
        const pre = tf?.purpose === 'setup' ? tf.preauth_token : undefined;
        set({ isLoading: true, error: null });
        try {
          const response = await authApi.totpEnable(code, pre);
          authApi.storeAuth(response);
          scheduleProactiveRefresh(response.access_token);
          set({
            user: response.user,
            isAuthenticated: true,
            isLoading: false,
            authVerified: true,
            backupCodes: response.backup_codes,
            twoFactor: null,
            setupData: null,
            error: null,
          });
        } catch (error) {
          const message = getAuthErrorMessage(error, 'Could not enable two-factor authentication');
          set({ error: message, isLoading: false });
          throw error;
        }
      },

      cancelTwoFactor: () => {
        set({
          twoFactor: null,
          setupData: null,
          backupCodes: null,
          error: null,
          isLoading: false,
        });
      },

      clearBackupCodes: () => {
        set({ backupCodes: null });
      },

      disableTwoFactor: async (opts: { current_password?: string; code?: string }) => {
        set({ isLoading: true, error: null });
        try {
          await authApi.totpDisable(opts);
          const me = await authApi.getMe();
          get().setUser(me);
          set({ isLoading: false, setupData: null, backupCodes: null });
        } catch (error) {
          const message = getAuthErrorMessage(error, 'Could not disable two-factor authentication');
          set({ error: message, isLoading: false });
          throw error;
        }
      },

      regenerateBackupCodes: async (code: string) => {
        set({ isLoading: true, error: null });
        try {
          const response = await authApi.totpRegenerateBackupCodes(code);
          set({ backupCodes: response.backup_codes, isLoading: false });
        } catch (error) {
          const message = getAuthErrorMessage(error, 'Could not regenerate backup codes');
          set({ error: message, isLoading: false });
          throw error;
        }
      },

      logout: () => {
        // Local sessions have no server-side token to revoke; skip the API
        // call and just clear the persisted session. The local workspace UUID
        // is intentionally kept so a later local login reopens the same data.
        if (get().user?.isLocal) {
          clearUserData();
        } else {
          authApi.logout();
        }
        cancelProactiveRefresh();
        set({
          user: null,
          isAuthenticated: false,
          authVerified: false,
        });
      },

      /** Clear local session state without calling the server. Used when the API
       * client detects an irrecoverable 401 and is about to redirect. */
      clearSession: () => {
        cancelProactiveRefresh();
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
