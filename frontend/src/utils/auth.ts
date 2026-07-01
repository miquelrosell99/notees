/**
 * Centralized authentication helpers
 *
 * Access tokens are now stored in an HTTPOnly cookie set by the backend, so
 * this module no longer reads or writes the JWT to localStorage. It only
 * manages non-sensitive user data and long-lived API keys (which still require
 * localStorage so they can be sent as the X-API-Key header).
 */

const USER_KEY = 'user';
const API_KEY_KEY = 'api_key';

/**
 * Store user data in storage.
 * When running inside the Android app, native encrypted storage is the source
 * of truth and we do NOT mirror back to localStorage.
 */
export function setUserData(user: unknown): void {
  const json = JSON.stringify(user);
  if (isAndroidApp() && typeof window.Android!.storeUserData === 'function') {
    window.Android!.storeUserData(json);
  } else {
    localStorage.setItem(USER_KEY, json);
  }
}

/**
 * Get stored user data.
 * Prefers native encrypted storage when running inside the Android app.
 */
export function getUserData<T = unknown>(): T | null {
  if (isAndroidApp() && typeof window.Android!.getUserData === 'function') {
    const nativeUser = window.Android!.getUserData();
    if (nativeUser) {
      try {
        return JSON.parse(nativeUser) as T;
      } catch {
        return null;
      }
    }
    return null;
  }

  const userStr = localStorage.getItem(USER_KEY);
  if (!userStr) return null;
  try {
    return JSON.parse(userStr) as T;
  } catch {
    return null;
  }
}

/**
 * Clear stored user data from all storage layers.
 */
export function clearUserData(): void {
  if (isAndroidApp() && typeof window.Android!.clearUserData === 'function') {
    window.Android!.clearUserData();
  } else {
    localStorage.removeItem(USER_KEY);
  }
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
  // Notify other tabs / listeners that this session has ended.
  try {
    localStorage.setItem('auth:logout', Date.now().toString());
  } catch {
    // Ignore storage errors (e.g., private mode).
  }
  window.dispatchEvent(new CustomEvent('auth:unauthorized'));
  if (window.location.pathname !== '/auth') {
    window.location.href = '/auth';
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
 * Prefers native encrypted storage when running inside the Android app.
 */
export function getApiKey(): string | null {
  if (isAndroidApp() && typeof window.Android!.getApiKey === 'function') {
    return window.Android!.getApiKey();
  }
  return localStorage.getItem(API_KEY_KEY);
}

/**
 * Store an API key.
 * When running inside the Android app, native encrypted storage is the source
 * of truth and we do NOT mirror back to localStorage.
 */
export function setApiKey(key: string): void {
  if (isAndroidApp() && typeof window.Android!.storeApiKey === 'function') {
    window.Android!.storeApiKey(key);
  } else {
    localStorage.setItem(API_KEY_KEY, key);
  }
}

/**
 * Clear the stored API key.
 */
export function clearApiKey(): void {
  if (isAndroidApp() && typeof window.Android!.clearApiKey === 'function') {
    window.Android!.clearApiKey();
  } else {
    localStorage.removeItem(API_KEY_KEY);
  }
}

function isAndroidApp(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.Android?.isNativeApp() === true
  );
}
