/**
 * Centralized authentication token management
 *
 * All token access goes through these functions to maintain consistency.
 * When running inside the Android WebView wrapper, reads/writes are mirrored
 * to native encrypted storage (EncryptedSharedPreferences) so auth survives
 * app updates and WebView component changes that would otherwise wipe
 * localStorage.
 */

const TOKEN_KEY = 'token';
const USER_KEY = 'user';
const AUTH_STORAGE_KEY = 'auth-storage';

function isAndroidApp(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.Android?.isNativeApp() === true
  );
}

// ── Token ───────────────────────────────────────────────────────────────────

/**
 * Get the authentication token from storage.
 * Prefers native encrypted storage when running inside the Android app.
 */
export function getAuthToken(): string | null {
  if (isAndroidApp()) {
    const nativeToken = window.Android!.getAuthToken();
    if (nativeToken) {
      // Sync back to localStorage so the rest of the app stays compatible
      localStorage.setItem(TOKEN_KEY, nativeToken);
      return nativeToken;
    }
  }
  return localStorage.getItem(TOKEN_KEY);
}

/**
 * Store the authentication token.
 * Mirrors to native encrypted storage when running inside the Android app.
 */
export function setAuthToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  if (isAndroidApp()) {
    window.Android!.storeAuthToken(token);
  }
}

/**
 * Clear the authentication token from all storage layers.
 */
export function clearAuthToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(AUTH_STORAGE_KEY);
  if (isAndroidApp()) {
    window.Android!.clearAuthToken();
    window.Android!.clearUserData();
  }
}

/**
 * Check if user has a stored authentication token
 */
export function isAuthenticated(): boolean {
  return !!getAuthToken();
}

// ── User data ───────────────────────────────────────────────────────────────

/**
 * Store user data in storage.
 * Mirrors to native encrypted storage when running inside the Android app.
 */
export function setUserData(user: unknown): void {
  const json = JSON.stringify(user);
  localStorage.setItem(USER_KEY, json);
  if (isAndroidApp()) {
    window.Android!.storeUserData(json);
  }
}

/**
 * Get stored user data.
 * Prefers native encrypted storage when running inside the Android app.
 */
export function getUserData<T = unknown>(): T | null {
  if (isAndroidApp()) {
    const nativeUser = window.Android!.getUserData();
    if (nativeUser) {
      localStorage.setItem(USER_KEY, nativeUser);
      try {
        return JSON.parse(nativeUser) as T;
      } catch {
        return null;
      }
    }
  }

  const userStr = localStorage.getItem(USER_KEY);
  if (!userStr) return null;
  try {
    return JSON.parse(userStr) as T;
  } catch {
    return null;
  }
}
