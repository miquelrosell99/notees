/**
 * Centralized authentication token management
 * 
 * All localStorage token access should go through these functions
 * to maintain consistency and enable future updates (e.g., secure storage).
 */

const TOKEN_KEY = 'token';
const USER_KEY = 'user';

/**
 * Get the authentication token from storage
 */
export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/**
 * Store the authentication token
 */
export function setAuthToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

/**
 * Clear the authentication token from storage
 */
export function clearAuthToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/**
 * Check if user has a stored authentication token
 */
export function isAuthenticated(): boolean {
  return !!getAuthToken();
}

/**
 * Store user data in localStorage
 */
export function setUserData(user: unknown): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

/**
 * Get stored user data
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
