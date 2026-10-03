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
  headers.set("Content-Type", "application/json");
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

export interface WorkspaceExport {
  blob: Blob;
  /** Suggested filename from the content-disposition header (already .zip). */
  filename: string;
}

export interface WorkspaceExportOptions {
  /**
   * 1 bundles the CAS bytes of every asset the exported pages reference
   * under assets/ and rewrites the Markdown refs; 0 (default) keeps the raw
   * uuid references and adds no bytes.
   */
  includeAssets?: boolean;
}

/**
 * Download a full-workspace ZIP export (any membership role): one Markdown
 * file per page plus the bundle manifest; the server bundles referenced
 * asset bytes only when asked (?includeAssets=1 — the E6 export modal owns
 * that toggle).
 */
export async function exportWorkspace(
  serverUrl: string,
  token: string,
  workspaceId: string,
  fallbackName: string,
  options: WorkspaceExportOptions = {},
): Promise<WorkspaceExport> {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  const includeAssets = options.includeAssets === true ? "1" : "0";
  const response = await fetch(
    `${serverUrl.replace(/\/$/, "")}/api/workspaces/${encodeURIComponent(workspaceId)}/export.zip?includeAssets=${includeAssets}`,
    { headers },
  );
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
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match?.[1] ?? `${fallbackName.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "workspace"}.zip`;
  return { blob: await response.blob(), filename };
}
