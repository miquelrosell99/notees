import type { Hlc } from './clock';

export interface EncryptedEnvelope {
  id: string;
  ciphertext: string; // base64
  iv: string; // base64
  workspaceId: string;
  actorId: string;
  affectedNodeIds: string[];
  opType: string;
  hlc: Hlc;
}

const ENCODER = new TextEncoder();

export async function deriveKey(password: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', ENCODER.encode(password), 'PBKDF2', false, ['deriveKey']);
  const salt = ENCODER.encode('notees-ideal-prototype-salt');
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Derive a user-specific AES wrapping key from the user id and the shared secret.
 *
 * TODO(D6): Phase 6 should move to true client-side key generation. This
 * prototype mirrors the server-side `derive_user_wrapping_key` helper so the
 * client can unwrap a workspace key that was wrapped by the server.
 */
export async function deriveUserWrappingKey(userId: string, secret: string): Promise<CryptoKey> {
  return deriveKey(`${userId}:${secret}`);
}

/**
 * Convenience to derive the workspace AES key from the workspace id and secret.
 *
 * TODO(D6): Phase 6 should move to true client-side key generation. This
 * prototype mirrors the server-side `derive_workspace_key` helper.
 */
export async function deriveWorkspaceKey(workspaceId: string, secret: string): Promise<CryptoKey> {
  return deriveKey(`${workspaceId}:${secret}`);
}

/**
 * Unwrap a workspace master key that was wrapped with a user wrapping key.
 *
 * Returns a `CryptoKey` suitable for AES-GCM encrypt/decrypt. The raw bytes are
 * imported as non-extractable because callers should never need to serialize the
 * unwrapped master key.
 */
export async function unwrapWorkspaceKey(
  wrapped: { ciphertext: string; iv: string },
  wrappingKey: CryptoKey
): Promise<CryptoKey> {
  const iv = Uint8Array.from(atob(wrapped.iv), (c) => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(wrapped.ciphertext), (c) => c.charCodeAt(0));
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, wrappingKey, ciphertext);
  return crypto.subtle.importKey('raw', decrypted, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptEnvelope(
  payload: unknown,
  key: CryptoKey,
  metadata: {
    id: string;
    workspaceId: string;
    actorId: string;
    affectedNodeIds: string[];
    opType: string;
    hlc: Hlc;
  }
): Promise<EncryptedEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = ENCODER.encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return {
    id: metadata.id,
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
    iv: btoa(String.fromCharCode(...iv)),
    workspaceId: metadata.workspaceId,
    actorId: metadata.actorId,
    affectedNodeIds: metadata.affectedNodeIds,
    opType: metadata.opType,
    hlc: metadata.hlc,
  };
}

export async function decryptEnvelope(envelope: EncryptedEnvelope, key: CryptoKey): Promise<unknown> {
  const iv = Uint8Array.from(atob(envelope.iv), (c) => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(envelope.ciphertext), (c) => c.charCodeAt(0));
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(decrypted));
}
