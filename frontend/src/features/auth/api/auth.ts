/**
 * Authentication API functions
 */
import api from '@/api/client';
import { clearUserData, setUserData, getUserData, isAuthenticated as checkAuth } from '@/utils/auth';
import type { Token, UserCreate, UserLogin, User, AuthStatus, UserUpdate, PasswordChangeRequest, ApiKey, ApiKeyCreate, ApiKeyWithSecret } from '@/types';

/**
 * Register a new user
 */
export async function register(data: UserCreate): Promise<Token> {
  const response = await api.post<Token>('/auth/register', data);
  return response.data;
}

/**
 * Login with credentials
 */
export async function login(data: UserLogin): Promise<Token> {
  const response = await api.post<Token>('/auth/login', data);
  return response.data;
}

/**
 * Get current user info
 */
export async function getMe(): Promise<User> {
  const response = await api.get<User>('/auth/me');
  return response.data;
}

/**
 * Get auth status (for first-boot detection)
 */
export async function getAuthStatus(): Promise<AuthStatus> {
  const response = await api.get<AuthStatus>('/auth/status');
  return response.data;
}

/**
 * Update current user profile
 */
export async function updateMe(data: UserUpdate): Promise<User> {
  const response = await api.put<User>('/auth/me', data);
  return response.data;
}

/**
 * Change the current user's password.
 *
 * This invalidates all refresh tokens and API keys on the backend; the caller
 * should log the user out locally after a successful response.
 */
export async function changePassword(data: PasswordChangeRequest): Promise<{ success: boolean }> {
  const response = await api.post<{ success: boolean }>('/auth/change-password', data);
  return response.data;
}

/**
 * Log out and clear authentication cookies on the backend.
 */
export async function logout(): Promise<void> {
  try {
    await api.post('/auth/logout');
  } finally {
    clearUserData();
  }
}

/**
 * Check if user data exists locally. This does not verify the session is still
 * valid on the server; use /api/auth/me for that.
 */
export function isAuthenticated(): boolean {
  return checkAuth();
}

/**
 * Store auth data after login/register.
 *
 * The access token lives in an HTTPOnly cookie set by the backend; only the
 * user profile is persisted locally.
 */
export function storeAuth(token: Token): void {
  setUserData(token.user);
}

/**
 * Get stored user
 */
export function getStoredUser(): User | null {
  return getUserData<User>();
}

/**
 * Create a new API key for device access
 */
export async function createApiKey(data: ApiKeyCreate): Promise<ApiKeyWithSecret> {
  const response = await api.post<ApiKeyWithSecret>('/auth/api-keys', data);
  return response.data;
}

/**
 * List all API keys for the current user
 */
export async function listApiKeys(): Promise<ApiKey[]> {
  const response = await api.get<ApiKey[]>('/auth/api-keys');
  return response.data;
}

/**
 * Revoke an API key
 */
export async function revokeApiKey(keyId: string): Promise<{ success: boolean }> {
  const response = await api.delete<{ success: boolean }>(`/auth/api-keys/${keyId}`);
  return response.data;
}

/**
 * Accept a pending invitation
 */
export async function acceptInvite(data: { token: string; password?: string; name?: string; remember_me?: boolean }): Promise<Token> {
  const response = await api.post<Token>('/auth/invites/accept', data);
  return response.data;
}
