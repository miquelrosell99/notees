/**
 * Client for the relay's workspace E2EE key record (SPEC §8). The server
 * stores only the wrapped blob — it is opaque ciphertext to the operator.
 */

import { getServerUrl } from '@/config/serverUrl';

export interface EncryptionKeyRecord {
  enabled: boolean;
  wrappedKey: string | null;
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
    return { enabled: false, wrappedKey: null };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => 'Unknown error');
    throw new Error(`Encryption key fetch failed (${response.status}): ${text}`);
  }
  const data = (await response.json()) as {
    workspaceId: string;
    wrappedKey: string | null;
    enabled: boolean;
  };
  return { enabled: data.enabled, wrappedKey: data.wrappedKey ?? null };
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
