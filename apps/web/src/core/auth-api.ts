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
  isAdmin: boolean;
}

export interface LoginResponse {
  token: string;
  expiresAt: number;
  user: AccountUser;
}

export interface WorkspaceEntry {
  id: string;
  name: string | null;
  role: string;
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
  input: { email: string; password: string; displayName?: string },
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
