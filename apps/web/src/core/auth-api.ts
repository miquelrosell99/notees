/**
 * Auth API — the account surface of the sync server (routes-auth.ts). Plain
 * fetch helpers; the sync transport itself is unchanged (the session token
 * travels in the X-API-Key / Bearer slots the API key used to occupy).
 */

export interface ServerInfo {
  name: string;
  version: string;
  protocolVersion: number;
  setupRequired: boolean;
}

export interface AccountUser {
  id: string;
  email: string;
  displayName: string | null;
  name: string | null;
  surnames: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
}

export interface LoginResponse {
  token: string;
  expiresAt: number;
  user: AccountUser;
  /** Password-derived key record (E2EE groundwork): scrypt params + wrapped master key. */
  kdf: {
    algorithm: "scrypt";
    N: number;
    r: number;
    p: number;
    salt: string;
    wrappedMasterKey: string;
    keyVerifier: string;
  };
}

export interface WorkspaceEntry {
  id: string;
  name: string | null;
  role: string;
  createdAt: number;
  envelopeCount: number;
  latestSeq: number;
}

async function request<T>(
  serverUrl: string,
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/v1${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // Keep the HTTP status message.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export function fetchServerInfo(serverUrl: string): Promise<ServerInfo> {
  return request<ServerInfo>(serverUrl, "/server-info");
}

export function setupAccount(
  serverUrl: string,
  input: { email: string; password: string; displayName?: string | undefined },
): Promise<LoginResponse> {
  return request<LoginResponse>(serverUrl, "/setup", { method: "POST", body: JSON.stringify(input) });
}

export function login(serverUrl: string, input: { email: string; password: string }): Promise<LoginResponse> {
  return request<LoginResponse>(serverUrl, "/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function logout(serverUrl: string, token: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(serverUrl, "/auth/logout", { method: "POST" }, token);
}

export function fetchMe(serverUrl: string, token: string): Promise<AccountUser> {
  return request<AccountUser>(serverUrl, "/auth/me", {}, token);
}

export function updateMe(
  serverUrl: string,
  token: string,
  input: {
    displayName?: string | null;
    name?: string | null;
    surnames?: string | null;
    avatarUrl?: string | null;
  },
): Promise<AccountUser> {
  return request<AccountUser>(
    serverUrl,
    "/auth/me",
    { method: "PATCH", body: JSON.stringify(input) },
    token,
  );
}

export function listWorkspaces(serverUrl: string, token: string): Promise<{ workspaces: WorkspaceEntry[] }> {
  return request<{ workspaces: WorkspaceEntry[] }>(serverUrl, "/workspaces", {}, token);
}

export function createWorkspace(serverUrl: string, token: string, name?: string): Promise<{ id: string }> {
  return request<{ id: string }>(
    serverUrl,
    "/workspaces",
    { method: "POST", body: JSON.stringify(name ? { name } : {}) },
    token,
  );
}

// --- API keys (user settings → machine credentials) -------------------------------

export interface ApiKeyEntry {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export function listApiKeys(serverUrl: string, token: string): Promise<{ apiKeys: ApiKeyEntry[] }> {
  return request<{ apiKeys: ApiKeyEntry[] }>(serverUrl, "/api-keys", {}, token);
}

export function createApiKey(
  serverUrl: string,
  token: string,
  name: string,
): Promise<{ apiKey: ApiKeyEntry; token: string }> {
  return request<{ apiKey: ApiKeyEntry; token: string }>(
    serverUrl,
    "/api-keys",
    { method: "POST", body: JSON.stringify({ name }) },
    token,
  );
}

export function revokeApiKey(serverUrl: string, token: string, id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(serverUrl, `/api-keys/${id}`, { method: "DELETE" }, token);
}
