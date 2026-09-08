/**
 * Enable/unlock flows for workspace E2EE (SPEC §8).
 *
 * The passphrase derives a KEK (PBKDF2); the workspace key (WK) is random,
 * wrapped with the KEK, and stored server-side as an opaque blob carrying
 * the KDF salt. The same flows keep the legacy encryptionStore (query-cache
 * encryption) in sync so the settings UI indicators stay truthful.
 */

import {
  generateWorkspaceKey,
  readWrappedKeySalt,
  registerWorkspaceKey,
  setWorkspaceE2eeEnabled,
  unwrapWorkspaceKey,
  wrapWorkspaceKey,
} from './e2ee';
import { fetchEncryptionKeyRecord, putEncryptionKeyRecord } from './e2eeApi';
import { deriveKey } from '@/utils/encryption';
import { useEncryptionStore } from '@/stores/encryptionStore';

function saltToBytes(salt: string): Uint8Array {
  return new Uint8Array([...atob(salt)].map((c) => c.charCodeAt(0)));
}

/**
 * Enable E2EE for a workspace with a new passphrase. Generates a fresh
 * workspace key, wraps it, and publishes the wrapped blob to the server.
 * Assumes the encryptionStore password was already set (KEK + salt exist).
 */
export async function enableWorkspaceE2ee(workspaceId: string): Promise<void> {
  const kek = useEncryptionStore.getState().getKey(workspaceId);
  const salt = useEncryptionStore.getState().getConfig(workspaceId).salt;
  if (!kek || !salt) {
    throw new Error('Set the encryption password first');
  }
  const workspaceKey = await generateWorkspaceKey();
  const blob = await wrapWorkspaceKey(workspaceKey, kek, salt);
  await putEncryptionKeyRecord(workspaceId, blob);
  registerWorkspaceKey(workspaceId, workspaceKey);
  setWorkspaceE2eeEnabled(workspaceId, true);
}

/**
 * Unlock an E2EE workspace with its passphrase: fetch the wrapped blob from
 * the server, derive the KEK from the passphrase + blob salt, and unwrap.
 * Returns false when the passphrase is wrong or the workspace is not E2EE.
 */
export async function unlockWorkspaceE2ee(workspaceId: string, password: string): Promise<boolean> {
  const record = await fetchEncryptionKeyRecord(workspaceId);
  if (!record.enabled || !record.wrappedKey) return false;
  const salt = readWrappedKeySalt(record.wrappedKey);
  if (!salt) return false;
  const kek = await deriveKey(password, saltToBytes(salt));
  let workspaceKey: CryptoKey;
  try {
    workspaceKey = await unwrapWorkspaceKey(record.wrappedKey, kek);
  } catch {
    return false; // wrong passphrase (GCM tag mismatch)
  }
  registerWorkspaceKey(workspaceId, workspaceKey);
  setWorkspaceE2eeEnabled(workspaceId, true);
  // Keep the legacy per-device store coherent so the settings UI shows the
  // workspace as enabled + unlocked with the blob's salt as the authority.
  useEncryptionStore.setState((state) => ({
    configs: { ...state.configs, [workspaceId]: { enabled: true, salt } },
    keys: { ...state.keys, [workspaceId]: kek },
  }));
  return true;
}
