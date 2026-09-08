/**
 * End-to-end encryption for the sync layer (protocol/SPEC.md §8).
 *
 * Model: a random per-workspace AES-256-GCM key (WK) encrypts envelope
 * payloads and snapshot blobs at the TRANSPORT boundary. The local op log
 * and derived store stay plaintext; the relay only ever sees:
 *   payload = { "$e": { "iv": base64, "ct": base64 } }
 * Routing metadata (workspaceId, actorId, seq, opType, affectedNodeIds,
 * HLC) stays plaintext — the documented tradeoff in SPEC §9.
 *
 * WK itself is never persisted raw. It is wrapped with a passphrase-derived
 * KEK (PBKDF2, see utils/encryption.ts deriveKey) and the wrapped blob is
 * stored server-side so the user's other devices can unwrap it after
 * entering the passphrase. The server operator cannot unwrap: the KEK
 * never leaves the client.
 *
 * Encrypted envelopes carry protocolVersion 2 so pre-E2EE clients fail
 * loud instead of applying ciphertext (SPEC §7).
 */

import type { OperationEnvelope } from './crypto';

export const PROTOCOL_VERSION_ENCRYPTED = 2;

const PAYLOAD_MARKER = '$e';
const IV_BYTES = 12;

export interface EncryptedPayload {
  $e: { iv: string; ct: string };
}

function toBase64(bytes: Uint8Array): string {
  let result = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    result += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(result);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function isEncryptedPayload(payload: unknown): payload is EncryptedPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    PAYLOAD_MARKER in payload &&
    typeof (payload as EncryptedPayload).$e?.iv === 'string' &&
    typeof (payload as EncryptedPayload).$e?.ct === 'string'
  );
}

/** Generate a fresh random workspace key. */
export async function generateWorkspaceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/** Wrap WK with the passphrase-derived KEK. The stored blob is a JSON
 * string carrying the KDF salt so a brand-new device can re-derive the KEK
 * from the passphrase alone. */
export async function wrapWorkspaceKey(
  workspaceKey: CryptoKey,
  kek: CryptoKey,
  kdfSalt: string
): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', workspaceKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, raw);
  const packed = new Uint8Array(IV_BYTES + ct.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ct), IV_BYTES);
  return JSON.stringify({ v: 1, salt: kdfSalt, wk: toBase64(packed) });
}

/** Read the KDF salt from a wrapped blob (needed before KEK derivation). */
export function readWrappedKeySalt(wrapped: string): string | null {
  try {
    const parsed = JSON.parse(wrapped) as { salt?: string };
    return typeof parsed.salt === 'string' ? parsed.salt : null;
  } catch {
    return null;
  }
}

function asBufferSource(bytes: Uint8Array): BufferSource {
  // TS 5.7 types Uint8Array as Uint8Array<ArrayBufferLike>, which is not
  // assignable to BufferSource (SharedArrayBuffer is excluded). Copy into a
  // freshly allocated ArrayBuffer-backed view.
  return new Uint8Array(bytes);
}

/** Unwrap a wrapped blob with the passphrase-derived KEK. */
export async function unwrapWorkspaceKey(wrapped: string, kek: CryptoKey): Promise<CryptoKey> {
  const parsed = JSON.parse(wrapped) as { wk?: string };
  if (typeof parsed.wk !== 'string') throw new Error('Invalid wrapped workspace key blob');
  const packed = fromBase64(parsed.wk);
  const iv = asBufferSource(packed.subarray(0, IV_BYTES));
  const ct = asBufferSource(packed.subarray(IV_BYTES));
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, kek, ct);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptPayload(key: CryptoKey, payload: unknown): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return { $e: { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) } };
}

export async function decryptPayload(key: CryptoKey, payload: EncryptedPayload): Promise<unknown> {
  const iv = asBufferSource(fromBase64(payload.$e.iv));
  const ct = asBufferSource(fromBase64(payload.$e.ct));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(plain));
}

/**
 * Encrypt snapshot bytes: raw layout iv || ciphertext (no JSON/base64 —
 * snapshots are already opaque bytes on the wire).
 */
export async function encryptBytes(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data as unknown as BufferSource
  );
  const packed = new Uint8Array(IV_BYTES + ct.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ct), IV_BYTES);
  return packed;
}

export async function decryptBytes(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = asBufferSource(data.subarray(0, IV_BYTES));
  const ct = asBufferSource(data.subarray(IV_BYTES));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new Uint8Array(plain);
}

/** Encrypt an envelope's payload and mark it protocolVersion 2. */
export async function encryptEnvelopePayload(
  key: CryptoKey,
  envelope: OperationEnvelope
): Promise<OperationEnvelope> {
  return {
    ...envelope,
    protocolVersion: PROTOCOL_VERSION_ENCRYPTED,
    payload: await encryptPayload(key, envelope.payload),
  };
}

/** Decrypt an envelope's payload when encrypted; plaintext passes through. */
export async function decryptEnvelopePayload(
  key: CryptoKey,
  envelope: OperationEnvelope
): Promise<OperationEnvelope> {
  if (!isEncryptedPayload(envelope.payload)) return envelope;
  return {
    ...envelope,
    payload: await decryptPayload(key, envelope.payload),
  };
}

// ─── In-memory workspace key registry ───────────────────────────────────────

const workspaceKeys = new Map<string, CryptoKey>();
const enabledWorkspaces = new Set<string>();

export function registerWorkspaceKey(workspaceId: string, key: CryptoKey): void {
  workspaceKeys.set(workspaceId, key);
}

export function getWorkspaceKey(workspaceId: string): CryptoKey | undefined {
  return workspaceKeys.get(workspaceId);
}

export function clearWorkspaceKey(workspaceId: string): void {
  workspaceKeys.delete(workspaceId);
}

/**
 * Mark a workspace as E2EE-enabled (set when the server record exists or the
 * user enables it). Transport checks this per call, so enabling takes effect
 * on the next push without recreating the transport.
 */
export function setWorkspaceE2eeEnabled(workspaceId: string, enabled: boolean): void {
  if (enabled) {
    enabledWorkspaces.add(workspaceId);
  } else {
    enabledWorkspaces.delete(workspaceId);
  }
}

export function isWorkspaceE2eeEnabled(workspaceId: string): boolean {
  return enabledWorkspaces.has(workspaceId);
}
