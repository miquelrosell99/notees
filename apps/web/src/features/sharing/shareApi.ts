/**
 * Shares API — the share-token slice of the sync server (routes-shares.ts
 * shares record). Plain fetch helpers mirroring core/auth-api's and
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
  // 204 (and any empty) answers carry no JSON body.
  const text = await response.text();
  return (text === "" ? undefined : (JSON.parse(text) as T)) as T;
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

/**
 * Attach (or replace) a share's sealed artifact — the b64u iv ‖ tag ‖ ct
 * ciphertext (plan 08). The decryption key NEVER travels here: it lives only
 * in the published link's #fragment.
 */
export function putShareArtifact(
  serverUrl: string,
  token: string,
  shareToken: string,
  ciphertext: string,
): Promise<void> {
  return request<void>(
    serverUrl,
    `/shares/${encodeURIComponent(shareToken)}/artifact`,
    { method: "PUT", body: JSON.stringify({ ciphertext }) },
    token,
  );
}

// --- Per-node grants (the per-node-sharing trusted-circle v1) -----------------

export interface GrantEntry {
  id: string;
  nodeId: string;
  /** Set when the grantee already had an account at mint time. */
  granteeUserId: string | null;
  /** The email the grant was minted against (pending grants have no user id). */
  granteeEmail: string | null;
  role: "read" | "edit";
  createdBy: string;
  createdAt: number;
}

export interface InboxGrantEntry extends GrantEntry {
  workspaceId: string;
  /** Null when the operator key minted the grant (not a user row). */
  grantedByEmail: string | null;
  grantedByDisplayName: string | null;
  /** The caller's membership role on the grant's workspace ("member" = restricted). */
  workspaceRole: "owner" | "member" | string | null;
}

/** Grant a user read/edit access to the node's whole subtree (owner/admin only). */
export function createGrant(
  serverUrl: string,
  token: string,
  input: { nodeId: string; granteeUserId?: string; granteeEmail?: string; role?: "read" | "edit" },
): Promise<{ grant: GrantEntry }> {
  return request<{ grant: GrantEntry }>(serverUrl, "/grants", { method: "POST", body: JSON.stringify(input) }, token);
}

/** List a node's live grants (owner/admin only). */
export function listNodeGrants(serverUrl: string, token: string, nodeId: string): Promise<{ grants: GrantEntry[] }> {
  return request<{ grants: GrantEntry[] }>(serverUrl, `/grants?nodeId=${encodeURIComponent(nodeId)}`, {}, token);
}

/** Revoke a grant — the write-guard and the inbox drop it immediately. */
export function revokeGrant(serverUrl: string, token: string, grantId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(serverUrl, `/grants/${encodeURIComponent(grantId)}`, { method: "DELETE" }, token);
}

/** The Shares Inbox — the live grants matching the authenticated user. */
export function fetchGrantInbox(serverUrl: string, token: string): Promise<{ grants: InboxGrantEntry[] }> {
  return request<{ grants: InboxGrantEntry[] }>(serverUrl, "/grants/inbox", {}, token);
}

// --- Confidential shares (password-sealed reads for non-members) --------------

export interface ConfidentialShareEntry {
  id: string;
  workspaceId: string;
  nodeId: string;
  /** The owner's plaintext label — the addressee cannot resolve the node. */
  displayName: string;
  grantedByEmail: string | null;
  grantedByDisplayName: string | null;
  createdAt: number;
}

export interface ConfidentialKdfWire {
  algorithm: "scrypt";
  N: number;
  r: number;
  p: number;
}

/** Publish a confidential read share — the CIPHERTEXT + KDF params only. */
export function createConfidentialShare(
  serverUrl: string,
  token: string,
  input: {
    nodeId: string;
    recipientEmail: string;
    displayName: string;
    artifact: string;
    salt: string;
    kdf: ConfidentialKdfWire;
  },
): Promise<{ share: { id: string; nodeId: string; createdAt: number } }> {
  return request<{ share: { id: string; nodeId: string; createdAt: number } }>(
    serverUrl,
    "/confidential-shares",
    { method: "POST", body: JSON.stringify(input) },
    token,
  );
}

/** The confidential-share inbox — rows addressed to the caller's email. */
export function fetchConfidentialInbox(serverUrl: string, token: string): Promise<{ shares: ConfidentialShareEntry[] }> {
  return request<{ shares: ConfidentialShareEntry[] }>(serverUrl, "/confidential-shares/inbox", {}, token);
}

/** Fetch one share's ciphertext + KDF params (the addressee's session only). */
export function fetchConfidentialArtifact(
  serverUrl: string,
  token: string,
  shareId: string,
): Promise<{ artifact: string; salt: string; kdf: ConfidentialKdfWire }> {
  return request<{ artifact: string; salt: string; kdf: ConfidentialKdfWire }>(
    serverUrl,
    `/confidential-shares/${encodeURIComponent(shareId)}/artifact`,
    {},
    token,
  );
}

/** Revoke a confidential share (owner/admin; the inbox drops it immediately). */
export function revokeConfidentialShare(serverUrl: string, token: string, shareId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(
    serverUrl,
    `/confidential-shares/${encodeURIComponent(shareId)}`,
    { method: "DELETE" },
    token,
  );
}
