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
  if (isAndroidApp() && typeof window.Android!.getAuthToken === 'function') {
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
  if (isAndroidApp() && typeof window.Android!.storeAuthToken === 'function') {
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
    if (typeof window.Android!.clearAuthToken === 'function') {
      window.Android!.clearAuthToken();
    }
    if (typeof window.Android!.clearUserData === 'function') {
      window.Android!.clearUserData();
    }
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
  if (isAndroidApp() && typeof window.Android!.storeUserData === 'function') {
    window.Android!.storeUserData(json);
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

// ── API key (for device/background access) ──────────────────────────────────

const API_KEY_KEY = 'api_key';

/**
 * Get the API key for the current server.
 * Prefers native encrypted storage when running inside the Android app.
 */
export function getApiKey(): string | null {
  if (isAndroidApp() && typeof window.Android!.getApiKey === 'function') {
    const nativeKey = window.Android!.getApiKey();
    if (nativeKey) {
      localStorage.setItem(API_KEY_KEY, nativeKey);
      return nativeKey;
    }
  }
  return localStorage.getItem(API_KEY_KEY);
}

/**
 * Store an API key.
 * Mirrors to native encrypted storage when running inside the Android app.
 */
export function setApiKey(key: string): void {
  localStorage.setItem(API_KEY_KEY, key);
  if (isAndroidApp() && typeof window.Android!.storeApiKey === 'function') {
    window.Android!.storeApiKey(key);
  }
}

/**
 * Clear the stored API key.
 */
export function clearApiKey(): void {
  localStorage.removeItem(API_KEY_KEY);
  if (isAndroidApp() && typeof window.Android!.clearApiKey === 'function') {
    window.Android!.clearApiKey();
  }
}
