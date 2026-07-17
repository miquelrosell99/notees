import type { Hlc } from './clock';

export interface EncryptedEnvelope {
  id: string;
  ciphertext: string; // base64
  iv: string; // base64
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

export async function encryptEnvelope(
  payload: unknown,
  key: CryptoKey,
  metadata: { id: string; actorId: string; affectedNodeIds: string[]; opType: string; hlc: Hlc }
): Promise<EncryptedEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = ENCODER.encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return {
    id: metadata.id,
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
    iv: btoa(String.fromCharCode(...iv)),
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
