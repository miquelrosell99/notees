/**
 * Authentication API functions
 */
import api from './client';
import { getAuthToken, setAuthToken, clearAuthToken, isAuthenticated as checkAuth, setUserData, getUserData } from '@/utils/auth';
import type { Token, UserCreate, UserLogin, User, AuthStatus, UserUpdate, ApiKey, ApiKeyCreate, ApiKeyWithSecret } from '@/types';

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
 * Logout (client-side only for JWT)
 */
export function logout(): void {
  clearAuthToken();
}

/**
 * Check if user is authenticated
 */
export function isAuthenticated(): boolean {
  return checkAuth();
}

/**
 * Get stored token
 */
export function getToken(): string | null {
  return getAuthToken();
}

/**
 * Store auth data after login/register
 */
export function storeAuth(token: Token): void {
  setAuthToken(token.access_token);
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
export async function acceptInvite(data: { token: string; password?: string; name?: string }): Promise<Token> {
  const response = await api.post<Token>('/auth/invites/accept', data);
  return response.data;
}
