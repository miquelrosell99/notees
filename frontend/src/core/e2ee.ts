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
  $e: { iv: string; ct: string; kv?: number };
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

export async function encryptPayload(
  key: CryptoKey,
  payload: unknown,
  keyVersion = 1
): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const marker: EncryptedPayload['$e'] = { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
  if (keyVersion > 1) marker.kv = keyVersion;
  return { $e: marker };
}

export async function decryptPayload(key: CryptoKey, payload: EncryptedPayload): Promise<unknown> {
  const iv = asBufferSource(fromBase64(payload.$e.iv));
  const ct = asBufferSource(fromBase64(payload.$e.ct));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(plain));
}

/**
 * Encrypt snapshot bytes. Format v2: UTF-8 JSON `{v, kv, iv, ct}` so the key
 * version travels with the blob (rotation keeps history decryptable) and the
 * SQLite-magic plaintext check keeps working (JSON never starts with it).
 */
export async function encryptBytes(
  key: CryptoKey,
  data: Uint8Array,
  keyVersion = 1
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, asBufferSource(data));
  return new TextEncoder().encode(
    JSON.stringify({ v: 2, kv: keyVersion, iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) })
  );
}

/**
 * Decrypt snapshot bytes. ``resolveKey`` maps a key version to a CryptoKey
 * (return undefined for unknown versions). Reads both the v2 JSON format and
 * the raw ``iv || ct`` format written by the first E2EE cut (always kv=1).
 */
export async function decryptBytes(
  data: Uint8Array,
  resolveKey: (keyVersion: number) => CryptoKey | undefined
): Promise<Uint8Array> {
  if (data[0] === 0x7b) {
    // '{' — v2 JSON header.
    const parsed = JSON.parse(new TextDecoder().decode(data)) as {
      v?: number;
      kv?: number;
      iv?: string;
      ct?: string;
    };
    if (parsed.v === 2 && parsed.iv && parsed.ct) {
      const key = resolveKey(parsed.kv ?? 1);
      if (!key) throw new Error(`No workspace key for key version ${parsed.kv ?? 1}`);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: asBufferSource(fromBase64(parsed.iv)) },
        key,
        asBufferSource(fromBase64(parsed.ct))
      );
      return new Uint8Array(plain);
    }
    // Not a v2 header despite the leading brace — fall through to raw.
  }
  // Raw iv || ct (first E2EE cut).
  const key = resolveKey(1);
  if (!key) throw new Error('No workspace key for key version 1');
  const iv = asBufferSource(data.subarray(0, IV_BYTES));
  const ct = asBufferSource(data.subarray(IV_BYTES));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new Uint8Array(plain);
}

/** Encrypt an envelope's payload and mark it protocolVersion 2. */
export async function encryptEnvelopePayload(
  key: CryptoKey,
  envelope: OperationEnvelope,
  keyVersion = 1
): Promise<OperationEnvelope> {
  return {
    ...envelope,
    protocolVersion: PROTOCOL_VERSION_ENCRYPTED,
    payload: await encryptPayload(key, envelope.payload, keyVersion),
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

// ─── Key ring (rotation-aware) ──────────────────────────────────────────────
//
// Per workspace, a map of keyVersion → CryptoKey. Rotations (member removal)
// add a new version; history stays readable with older versions. Envelope
// markers carry `kv` when the version is > 1; snapshots are encrypted with
// the latest version.

const workspaceKeyRings = new Map<string, Map<number, CryptoKey>>();
const enabledWorkspaces = new Set<string>();

/** Register a workspace key; version 1 is the initial/passphrase-era key. */
export function registerWorkspaceKey(workspaceId: string, key: CryptoKey, version = 1): void {
  let ring = workspaceKeyRings.get(workspaceId);
  if (!ring) {
    ring = new Map();
    workspaceKeyRings.set(workspaceId, ring);
  }
  ring.set(version, key);
}

/** The latest (current) workspace key, or undefined when locked. */
export function getWorkspaceKey(workspaceId: string): CryptoKey | undefined {
  const version = getLatestKeyVersion(workspaceId);
  return version === null ? undefined : workspaceKeyRings.get(workspaceId)?.get(version);
}

/** The workspace key at a specific version (for decrypting history). */
export function getWorkspaceKeyForVersion(
  workspaceId: string,
  version: number
): CryptoKey | undefined {
  return workspaceKeyRings.get(workspaceId)?.get(version);
}

export function getLatestKeyVersion(workspaceId: string): number | null {
  const ring = workspaceKeyRings.get(workspaceId);
  if (!ring || ring.size === 0) return null;
  return Math.max(...ring.keys());
}

export function clearWorkspaceKey(workspaceId: string): void {
  workspaceKeyRings.delete(workspaceId);
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


// ─── E2EE v2: per-member X25519 key wrapping ────────────────────────────────
//
// Each user has an X25519 identity keypair per device; the public key is
// published server-side. The workspace owner wraps WK for each member:
// ECDH(ownerPrivate, memberPublic) → AES-GCM. Rotation on member removal
// creates a new WK (new key version) wrapped for remaining members only —
// removed members keep old-version history (they had the key) but cannot
// read new ops. v1 passphrase blobs ({v:1}) remain readable.

export interface MemberWrappedKey {
  v: 2;
  /** Sender's X25519 public key (base64 raw) — the member derives the shared key from it. */
  from: string;
  iv: string;
  ct: string;
  /** Workspace key version this blob carries. */
  kv: number;
}

export async function generateIdentityKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return toBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
}

export async function importPublicKey(base64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', asBufferSource(fromBase64(base64)), { name: 'X25519' }, true, []);
}

export async function exportPrivateKey(key: CryptoKey): Promise<string> {
  return toBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', key)));
}

export async function importPrivateKey(base64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', asBufferSource(fromBase64(base64)), { name: 'X25519' }, true, [
    'deriveBits',
  ]);
}

async function deriveSharedKey(myPrivate: CryptoKey, theirPublic: CryptoKey): Promise<CryptoKey> {
  const bits = await crypto.subtle.deriveBits(
    { name: 'X25519', public: theirPublic },
    myPrivate,
    256
  );
  return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** Wrap WK for a member, signed by the sender's public key so the member can derive the shared key. */
export async function wrapWorkspaceKeyForMember(
  workspaceKey: CryptoKey,
  myPrivateKey: CryptoKey,
  myPublicKeyBase64: string,
  theirPublicKeyBase64: string,
  keyVersion: number
): Promise<string> {
  const theirPublic = await importPublicKey(theirPublicKeyBase64);
  const shared = await deriveSharedKey(myPrivateKey, theirPublic);
  const raw = await crypto.subtle.exportKey('raw', workspaceKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, shared, raw);
  const blob: MemberWrappedKey = {
    v: 2,
    from: myPublicKeyBase64,
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(ct)),
    kv: keyVersion,
  };
  return JSON.stringify(blob);
}

/** Unwrap a member blob with my private key. Returns key + its version. */
export async function unwrapWorkspaceKeyAsMember(
  wrapped: string,
  myPrivateKey: CryptoKey
): Promise<{ key: CryptoKey; keyVersion: number }> {
  const blob = JSON.parse(wrapped) as Partial<MemberWrappedKey>;
  if (blob.v !== 2 || !blob.from || !blob.iv || !blob.ct || !blob.kv) {
    throw new Error('Invalid member-wrapped workspace key blob');
  }
  const senderPublic = await importPublicKey(blob.from);
  const shared = await deriveSharedKey(myPrivateKey, senderPublic);
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asBufferSource(fromBase64(blob.iv)) },
    shared,
    asBufferSource(fromBase64(blob.ct))
  );
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  return { key, keyVersion: blob.kv };
}
