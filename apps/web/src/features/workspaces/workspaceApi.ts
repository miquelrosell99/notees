/**
 * Workspace API — the workspace-management slice of the sync server's
 * account surface. Plain fetch helpers mirroring core/auth-api's request
 * shape; the rename endpoint is PATCH /workspaces/:id (owner-only server
 * side).
 */

export interface RenameWorkspaceResult {
  id: string;
  name: string | null;
}

async function request<T>(
  serverUrl: string,
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  // Content-Type only when bytes ride along: Fastify rejects an empty body
  // with a declared JSON type (API-key revoke + workspace delete 400'd).
  if (init.body !== undefined && init.body !== null) {
    headers.set("Content-Type", "application/json");
  }
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api${path}`, {
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

/** Rename a workspace (the account must hold the owner membership role). */
export function renameWorkspace(
  serverUrl: string,
  token: string,
  workspaceId: string,
  name: string,
): Promise<RenameWorkspaceResult> {
  return request<RenameWorkspaceResult>(
    serverUrl,
    `/workspaces/${encodeURIComponent(workspaceId)}`,
    { method: "PATCH", body: JSON.stringify({ name }) },
    token,
  );
}

/** Delete a workspace AND all its data (owner-only server side). */
export function deleteWorkspace(
  serverUrl: string,
  token: string,
  workspaceId: string,
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(
    serverUrl,
    `/workspaces/${encodeURIComponent(workspaceId)}`,
    { method: "DELETE" },
    token,
  );
}

