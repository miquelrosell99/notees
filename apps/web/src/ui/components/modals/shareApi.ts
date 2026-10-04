/**
 * Shares API — the share-token slice of the sync server (routes-shares.ts,
 * §34.62 shares record). Plain fetch helpers mirroring core/auth-api's and
 * workspaceApi's request shape: the session token (or operator key) rides the
 * Authorization slot. All routes are owner/admin-gated server-side.
 */

export interface ShareEntry {
  token: string;
  /** The public route's path — prefix the server origin for the full link. */
  urlPath: string;
  nodeId: string;
  workspaceId: string;
  createdBy: string | null;
  createdAt: number;
  /** Epoch millis after which the link stops resolving; null = no expiry. */
  expiresAt: number | null;
  revokedAt: number | null;
}

async function request<T>(
  serverUrl: string,
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  // Content-Type only when bytes ride along: Fastify rejects an empty body
  // under an application/json content-type (the DELETE/GET routes take none).
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

/** Mint a read-only public share link for a page (expiresAt omitted = never). */
export function createShare(
  serverUrl: string,
  token: string,
  nodeId: string,
  expiresAt?: number,
): Promise<{ share: ShareEntry }> {
  return request<{ share: ShareEntry }>(
    serverUrl,
    "/shares",
    { method: "POST", body: JSON.stringify(expiresAt === undefined ? { nodeId } : { nodeId, expiresAt }) },
    token,
  );
}

/** List the workspace's shares (optionally one page's), newest first. */
export function listShares(
  serverUrl: string,
  token: string,
  nodeId?: string,
): Promise<{ shares: ShareEntry[] }> {
  return request<{ shares: ShareEntry[] }>(
    serverUrl,
    nodeId === undefined ? "/shares" : `/shares?nodeId=${encodeURIComponent(nodeId)}`,
    {},
    token,
  );
}

/** Revoke a share link — the public view 404s from the next request on. */
export function revokeShare(
  serverUrl: string,
  token: string,
  shareToken: string,
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(
    serverUrl,
    `/shares/${encodeURIComponent(shareToken)}`,
    { method: "DELETE" },
    token,
  );
}
