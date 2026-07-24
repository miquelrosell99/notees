/**
 * Centralized authentication helpers
 *
 * Access tokens are stored in an HTTPOnly cookie set by the backend, so
 * this module does not read or write the JWT to localStorage. It only
 * manages non-sensitive user data and long-lived API keys (which still require
 * localStorage so they can be sent as the X-API-Key header).
 */

const USER_KEY = 'user';
const API_KEY_KEY = 'api_key';

/**
 * Store user data in storage.
 */
export function setUserData(user: unknown): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

/**
 * Get stored user data.
 */
export function getUserData<T = unknown>(): T | null {
  const userStr = localStorage.getItem(USER_KEY);
  if (!userStr) return null;
  try {
    return JSON.parse(userStr) as T;
  } catch {
    return null;
  }
}

/**
 * Clear stored user data.
 */
export function clearUserData(): void {
  localStorage.removeItem(USER_KEY);
}

/**
 * Clean up client-side auth state and redirect to the login page.
 *
 * Called from the API client (after refresh fails) and from the live-sync
 * WebSocket (when the server closes the socket with an auth error).
 */
export function handleAuthFailure(): void {
  clearUserData();
  localStorage.removeItem('auth-storage');
  // Drop the in-memory Zustand session immediately so the UI does not keep
  // rendering authenticated routes/loading overlays while the redirect happens.
  try {
    // Dynamic import avoids a circular dependency between api/client and the
    // auth store (the store imports api/client for refresh helpers).
    import('@/features/auth/stores/authStore').then(({ useAuthStore }) => {
      useAuthStore.getState().clearSession();
    });
  } catch {
    // Ignore import errors; localStorage removal + redirect is the fallback.
  }
  // Notify other tabs / listeners that this session has ended.
  try {
    localStorage.setItem('auth:logout', Date.now().toString());
  } catch {
    // Ignore storage errors (e.g., private mode).
  }
  window.dispatchEvent(new CustomEvent('auth:unauthorized'));
  // Always force a clean auth state. If we are already on /auth we still need
  // to reload so that any post-login loaders stop and the login form is shown
  // with a cleared session.
  const current = window.location.pathname;
  if (current !== '/auth') {
    window.location.href = '/auth';
  } else {
    window.location.reload();
  }
}

/**
 * Check if user data exists. Note: this does not verify that the session is
 * still valid; call /api/auth/me to confirm authentication state.
 */
export function isAuthenticated(): boolean {
  return !!getUserData();
}

// ── API key (for device/background access) ──────────────────────────────────

/**
 * Get the API key for the current server.
 */
export function getApiKey(): string | null {
  return localStorage.getItem(API_KEY_KEY);
}

/**
 * Store an API key.
 */
export function setApiKey(key: string): void {
  localStorage.setItem(API_KEY_KEY, key);
}

/**
 * Clear the stored API key.
 */
export function clearApiKey(): void {
  localStorage.removeItem(API_KEY_KEY);
}
