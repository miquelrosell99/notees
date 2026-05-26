/**
 * Authentication API functions
 */
import api from './client';
import { getAuthToken, setAuthToken, clearAuthToken, isAuthenticated as checkAuth, setUserData, getUserData } from '@/utils/auth';
import type { Token, UserCreate, UserLogin, User, AuthStatus, UserUpdate } from '@/types';

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
