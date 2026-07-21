/**
 * Authentication API functions
 */
import api from '@/api/client';
import { clearUserData, setUserData, getUserData, isAuthenticated as checkAuth } from '@/utils/auth';
import type {
  Token,
  UserCreate,
  UserLogin,
  User,
  AuthStatus,
  UserUpdate,
  PasswordChangeRequest,
  ApiKey,
  ApiKeyCreate,
  ApiKeyWithSecret,
  LoginResponse,
  TwoFactorRequiredResponse,
  TwoFactorSetupResponse,
  TwoFactorEnableResponse,
} from '@/types';

/**
 * Register a new user
 */
export async function register(data: UserCreate): Promise<Token> {
  const response = await api.post<Token>('/auth/register', data);
  return response.data;
}

/**
 * Login with credentials.
 *
 * Returns either a full {@link Token} or a {@link TwoFactorRequiredResponse}
 * when the account must complete a second factor (verification or forced
 * enrollment). Use {@link isTwoFactorRequired} to discriminate.
 */
export async function login(data: UserLogin): Promise<LoginResponse> {
  const response = await api.post<LoginResponse>('/auth/login', data);
  return response.data;
}

/**
 * Type guard: true when the login response is a 2FA challenge rather than a
 * full token set.
 */
export function isTwoFactorRequired(r: LoginResponse): r is TwoFactorRequiredResponse {
  return (r as TwoFactorRequiredResponse).requires_2fa === true;
}

function bearerHeader(preauthToken?: string): Record<string, string> | undefined {
  return preauthToken ? { Authorization: `Bearer ${preauthToken}` } : undefined;
}

/**
 * Start TOTP enrollment. During forced setup there is no session cookie yet, so
 * the `preauthToken` is sent as a Bearer header; during voluntary setup the
 * cookie session is used and no header is sent.
 */
export async function totpSetup(preauthToken?: string): Promise<TwoFactorSetupResponse> {
  const response = await api.post<TwoFactorSetupResponse>(
    '/auth/2fa/setup',
    undefined,
    { headers: bearerHeader(preauthToken) },
  );
  return response.data;
}

/**
 * Confirm TOTP enrollment with the first authenticator code. Issues full tokens
 * and returns the one-time backup codes.
 */
export async function totpEnable(
  code: string,
  preauthToken?: string,
): Promise<Token & TwoFactorEnableResponse> {
  const response = await api.post<Token & TwoFactorEnableResponse>(
    '/auth/2fa/enable',
    { code },
    { headers: bearerHeader(preauthToken) },
  );
  return response.data;
}

/**
 * Verify a TOTP (or backup) code for an in-progress login using the preauth
 * token issued by the login step.
 */
export async function totpVerify(preauthToken: string, code: string): Promise<Token> {
  const response = await api.post<Token>('/auth/2fa/verify', { preauth_token: preauthToken, code });
  return response.data;
}

/**
 * Disable TOTP for the current (cookie) session. Requires either the current
 * password or a valid authenticator/backup code.
 */
export async function totpDisable(
  opts: { current_password?: string; code?: string },
): Promise<{ success: boolean }> {
  const response = await api.post<{ success: boolean }>('/auth/2fa/disable', opts);
  return response.data;
}

/**
 * Regenerate the one-time backup codes for the current (cookie) session.
 */
export async function totpRegenerateBackupCodes(code: string): Promise<TwoFactorEnableResponse> {
  const response = await api.post<TwoFactorEnableResponse>(
    '/auth/2fa/backup-codes/regenerate',
    { code },
  );
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
export async function revokeApiKey(keyUuid: string): Promise<{ success: boolean }> {
  const response = await api.delete<{ success: boolean }>(`/auth/api-keys/${keyUuid}`);
  return response.data;
}

/**
 * Regenerate an existing API key's secret.
 *
 * Returns the new plaintext key **once** — copy it immediately.
 * The key's name, scopes, and expiration date are preserved.
 */
export async function regenerateApiKey(keyUuid: string): Promise<ApiKeyWithSecret> {
  const response = await api.post<ApiKeyWithSecret>(`/auth/api-keys/${keyUuid}/regenerate`);
  return response.data;
}

/**
 * Accept a pending invitation
 */
export async function acceptInvite(data: { token: string; password?: string; name?: string; remember_me?: boolean }): Promise<Token> {
  const response = await api.post<Token>('/auth/invites/accept', data);
  return response.data;
}
