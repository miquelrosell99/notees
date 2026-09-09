/**
 * Enable/unlock flows for workspace E2EE (SPEC §8).
 *
 * The passphrase derives a KEK (PBKDF2); the workspace key (WK) is random,
 * wrapped with the KEK, and stored server-side as an opaque blob carrying
 * the KDF salt. The same flows keep the legacy encryptionStore (query-cache
 * encryption) in sync so the settings UI indicators stay truthful.
 */

import {
  generateIdentityKeyPair,
  generateWorkspaceKey,
  getLatestKeyVersion,
  getWorkspaceKeyForVersion,
  getWorkspaceKeyVersions,
  readWrappedKeySalt,
  registerWorkspaceKey,
  setWorkspaceE2eeEnabled,
  unwrapWorkspaceKey,
  unwrapWorkspaceKeyAsMember,
  wrapWorkspaceKey,
  wrapWorkspaceKeyForMember,
  exportPrivateKey,
  exportPublicKey,
  importPrivateKey,
} from './e2ee';
import {
  deleteMemberKeys,
  fetchEncryptionKeyRecord,
  fetchUserPublicKey,
  publishUserPublicKey,
  putEncryptionKeyRecord,
  putMemberKeys,
} from './e2eeApi';
import { listWorkspaceMembers } from '@/features/shares/api/shares';
import { deriveKey } from '@/utils/encryption';
import { useEncryptionStore } from '@/stores/encryptionStore';

function saltToBytes(salt: string): Uint8Array {
  return new Uint8Array([...atob(salt)].map((c) => c.charCodeAt(0)));
}

/**
 * Enable E2EE for a workspace with a new passphrase. Generates a fresh
 * workspace key, wraps it with the passphrase KEK (recovery path), publishes
 * the blob, and also wraps the key for myself as a v2 member entry (sharing
 * path). Assumes the encryptionStore password was already set.
 */
export async function enableWorkspaceE2ee(workspaceId: string, userUuid: string): Promise<void> {
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

  // v2 member wrapping: I can unwrap with my device identity alone.
  const identity = await ensureIdentityKeyPair(userUuid);
  const selfWrapped = await wrapWorkspaceKeyForMember(
    workspaceKey,
    identity.privateKey,
    identity.publicKey,
    identity.publicKey,
    1
  );
  await putMemberKeys(workspaceId, [
    { userId: userUuid, wrappedKey: selfWrapped, keyVersion: 1 },
  ]);
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


// ─── E2EE v2 flows: device identity, member unwrap, wrap sweep, rotation ────

const IDENTITY_STORAGE_PREFIX = 'notees:x25519:';

export interface DeviceIdentity {
  publicKey: string;
  privateKey: CryptoKey;
}

/**
 * Load or create this device's X25519 identity keypair for a user. New pairs
 * are persisted to localStorage (device-trusted; SPEC §8) and the public key
 * is published server-side so workspace owners can wrap keys for this device.
 */
export async function ensureIdentityKeyPair(userUuid: string): Promise<DeviceIdentity> {
  const storageKey = `${IDENTITY_STORAGE_PREFIX}${userUuid}`;
  let stored: { publicKey: string; privateKey: string } | null = null;
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) stored = JSON.parse(raw) as { publicKey: string; privateKey: string };
  } catch {
    // Storage access may be restricted; fall through to regeneration.
  }
  if (stored?.publicKey && stored?.privateKey) {
    return {
      publicKey: stored.publicKey,
      privateKey: await importPrivateKey(stored.privateKey),
    };
  }

  const pair = await generateIdentityKeyPair();
  const publicKey = await exportPublicKey(pair.publicKey);
  const privateKey = await exportPrivateKey(pair.privateKey);
  try {
    localStorage.setItem(storageKey, JSON.stringify({ publicKey, privateKey }));
  } catch {
    // Non-persisted identity still works for this session.
  }
  await publishUserPublicKey(publicKey);
  return { publicKey, privateKey: pair.privateKey };
}

/**
 * Unlock an E2EE workspace via member-wrapped keys (v2): unwrap every version
 * the server holds for me into the local key ring. Returns false when no
 * member keys exist for me (v1 passphrase path or unlock modal handles that).
 */
export async function unlockWithMemberKeys(
  workspaceId: string,
  userUuid: string
): Promise<boolean> {
  const identity = await ensureIdentityKeyPair(userUuid);
  const record = await fetchEncryptionKeyRecord(workspaceId);
  if (!record.enabled || record.memberKeys.length === 0) return false;
  let any = false;
  for (const entry of record.memberKeys) {
    try {
      const { key, keyVersion } = await unwrapWorkspaceKeyAsMember(
        entry.wrappedKey,
        identity.privateKey
      );
      registerWorkspaceKey(workspaceId, key, keyVersion);
      any = true;
    } catch {
      // A blob that doesn't unwrap is not for this device or is corrupt; skip.
    }
  }
  if (any) setWorkspaceE2eeEnabled(workspaceId, true);
  return any;
}

/**
 * Owner/admin wrap sweep: wrap every locally held key version for every
 * member who has published a public key, upserting the results server-side.
 * Idempotent and self-healing — runs when an E2EE workspace opens so members
 * invited since the last sweep get their copies (invitees can't be wrapped
 * before they first publish a key).
 */
export async function wrapSweep(workspaceId: string, myUserUuid: string): Promise<void> {
  const versions = getWorkspaceKeyVersions(workspaceId);
  if (versions.length === 0) return;

  const membersResponse = await listWorkspaceMembers(workspaceId);
  const me = membersResponse.items.find((m) => m.user_uuid === myUserUuid);
  if (!me || (me.role !== 'owner' && me.role !== 'admin')) return;

  const identity = await ensureIdentityKeyPair(myUserUuid);
  const updates: Array<{ userId: string; wrappedKey: string; keyVersion: number }> = [];
  for (const member of membersResponse.items) {
    if (!member.user_uuid) continue;
    const theirPublicKey = await fetchUserPublicKey(member.user_uuid);
    if (!theirPublicKey) continue;
    for (const version of versions) {
      const wk = getWorkspaceKeyForVersion(workspaceId, version);
      if (!wk) continue;
      updates.push({
        userId: member.user_uuid,
        wrappedKey: await wrapWorkspaceKeyForMember(
          wk,
          identity.privateKey,
          identity.publicKey,
          theirPublicKey,
          version
        ),
        keyVersion: version,
      });
    }
  }
  if (updates.length > 0) {
    await putMemberKeys(workspaceId, updates);
  }
}

/**
 * Rotate the workspace key after a member removal: the removed member's
 * wrapped copies are deleted, a fresh WK is added at the next version, and
 * remaining members get wraps for all versions (so new devices still read
 * history). The removed member keeps old-version history (they had the key)
 * but cannot read ops encrypted with the new version.
 */
export async function rotateWorkspaceKey(
  workspaceId: string,
  myUserUuid: string,
  removedUserUuid?: string
): Promise<void> {
  if (removedUserUuid) {
    await deleteMemberKeys(workspaceId, removedUserUuid);
  }
  const newKey = await generateWorkspaceKey();
  const newVersion = (getLatestKeyVersion(workspaceId) ?? 0) + 1;
  registerWorkspaceKey(workspaceId, newKey, newVersion);
  await wrapSweep(workspaceId, myUserUuid);
}
