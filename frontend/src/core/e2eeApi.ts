/**
 * Client for the relay's workspace E2EE key record (SPEC §8). The server
 * stores only the wrapped blob — it is opaque ciphertext to the operator.
 */

import { getServerUrl } from '@/config/serverUrl';

export interface EncryptionKeyRecord {
  enabled: boolean;
  wrappedKey: string | null;
  /** Caller-only member-wrapped key copies (E2EE v2), one per key version. */
  memberKeys: Array<{ wrappedKey: string; keyVersion: number }>;
}

function baseUrl(): string {
  return (getServerUrl() ?? '').replace(/\/$/, '');
}

/** Fetch the workspace's wrapped-key record. enabled=false when none exists. */
export async function fetchEncryptionKeyRecord(workspaceId: string): Promise<EncryptionKeyRecord> {
  const response = await fetch(
    `${baseUrl()}/api/relay/encryption-key?workspace_id=${encodeURIComponent(workspaceId)}`,
    { credentials: 'include' }
  );
  if (response.status === 404) {
    return { enabled: false, wrappedKey: null, memberKeys: [] };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => 'Unknown error');
    throw new Error(`Encryption key fetch failed (${response.status}): ${text}`);
  }
  const data = (await response.json()) as {
    workspaceId: string;
    wrappedKey: string | null;
    enabled: boolean;
    memberKeys?: Array<{ wrappedKey: string; keyVersion: number }>;
  };
  return {
    enabled: data.enabled,
    wrappedKey: data.wrappedKey ?? null,
    memberKeys: data.memberKeys ?? [],
  };
}

/** Store the workspace's wrapped key blob (owner/admin). */
export async function putEncryptionKeyRecord(workspaceId: string, wrappedKey: string): Promise<void> {
  const response = await fetch(`${baseUrl()}/api/relay/encryption-key`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ workspace_id: workspaceId, wrapped_key: wrappedKey }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => 'Unknown error');
    throw new Error(`Encryption key store failed (${response.status}): ${text}`);
  }
}


// ─── E2EE v2: per-member wrapped keys (SPEC §8) ─────────────────────────────

/** Publish my X25519 public key (self; idempotent upsert). */
export async function publishUserPublicKey(publicKey: string): Promise<void> {
  const response = await fetch(`${baseUrl()}/api/relay/user-public-key`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ public_key: publicKey }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => 'Unknown error');
    throw new Error(`Public key publish failed (${response.status}): ${text}`);
  }
}

/** Fetch another user's published X25519 public key (null when none). */
export async function fetchUserPublicKey(userId: string): Promise<string | null> {
  const response = await fetch(
    `${baseUrl()}/api/relay/user-public-key?user_id=${encodeURIComponent(userId)}`,
    { credentials: 'include' }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => 'Unknown error');
    throw new Error(`Public key fetch failed (${response.status}): ${text}`);
  }
  const data = (await response.json()) as { userId: string; publicKey: string | null };
  return data.publicKey ?? null;
}

/** Upsert member-wrapped workspace key copies (owner/admin). */
export async function putMemberKeys(
  workspaceId: string,
  members: Array<{ userId: string; wrappedKey: string; keyVersion: number }>
): Promise<void> {
  const response = await fetch(`${baseUrl()}/api/relay/encryption-key/members`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      workspace_id: workspaceId,
      members: members.map((m) => ({
        user_id: m.userId,
        wrapped_key: m.wrappedKey,
        key_version: m.keyVersion,
      })),
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => 'Unknown error');
    throw new Error(`Member key store failed (${response.status}): ${text}`);
  }
}

/** Delete a removed member's wrapped key copies (owner/admin). */
export async function deleteMemberKeys(workspaceId: string, userId: string): Promise<void> {
  const response = await fetch(
    `${baseUrl()}/api/relay/encryption-key/members/${encodeURIComponent(workspaceId)}/${encodeURIComponent(userId)}`,
    { method: 'DELETE', credentials: 'include' }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => 'Unknown error');
    throw new Error(`Member key delete failed (${response.status}): ${text}`);
  }
}
