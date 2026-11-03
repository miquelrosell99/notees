/**
 * E2EE crypto primitives (client side). WebCrypto for AES-GCM; @noble/hashes
 * for scrypt/HMAC/SHA-256 (WebCrypto has no scrypt). Formats match the
 * server-side groundwork in apps/server/src/auth.ts: wrapped keys and
 * verifiers are base64url(iv ‖ tag ‖ ct) / base64url(HMAC-SHA256(...)).
 * Ports: GTK (cryptography), Flutter (Dart) — keep this file dependency-thin
 * and side-effect free; it is the reference for the lockstep corpus.
 */

import { hmac } from "@noble/hashes/hmac";
import { scrypt } from "@noble/hashes/scrypt";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToUtf8, utf8ToBytes } from "@noble/hashes/utils";
import { isEncryptedPayload, type Envelope } from "./envelope.js";

// WebCrypto type names (CryptoKey, KeyUsage, BufferSource) are ambient in the
// DOM lib, but this package compiles against lib ES2022 + @types/node 20,
// which keeps them under the `webcrypto` namespace only. CryptoKey derives
// from the declared global `crypto` (same Promise<CryptoKey> return under
// both lib regimes); KeyUsage and BufferSource are the fixed WebIDL
// definitions, spelled out so the module compiles identically with and
// without the DOM lib (web consumers read this source via the development
// condition). No `node:crypto` import — the module stays runtime-agnostic.
type CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
type KeyUsage =
  | "encrypt"
  | "decrypt"
  | "sign"
  | "verify"
  | "deriveKey"
  | "deriveBits"
  | "wrapKey"
  | "unwrapKey";
type BufferSource = ArrayBufferView<ArrayBuffer> | ArrayBuffer;

export const SCRYPT_PARAMS = { N: 131072, r: 8, p: 1 } as const;

// --- base64url -----------------------------------------------------------------

export function b64uEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --- small helpers ---------------------------------------------------------------

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function importAesKey(bytes: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", bytes as BufferSource, "AES-GCM", false, usages);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** WebCrypto returns ct ‖ tag(16); the wire format (auth.ts) is iv ‖ tag ‖ ct. */
function splitCtTag(sealed: Uint8Array): { ct: Uint8Array; tag: Uint8Array } {
  return { ct: sealed.slice(0, sealed.length - 16), tag: sealed.slice(sealed.length - 16) };
}

/** iv ‖ tag ‖ ct, matching the server groundwork in apps/server/src/auth.ts. */
function joinIvTagCt(iv: Uint8Array, tag: Uint8Array, ct: Uint8Array): Uint8Array {
  const out = new Uint8Array(iv.length + tag.length + ct.length);
  out.set(iv, 0);
  out.set(tag, iv.length);
  out.set(ct, iv.length + tag.length);
  return out;
}

/** Inverse of joinIvTagCt: WebCrypto's unwrap wants the seal back as ct ‖ tag. */
function ivTagCtToSealed(raw: Uint8Array): { iv: Uint8Array; sealed: Uint8Array } {
  const iv = raw.slice(0, 12);
  const tag = raw.slice(12, 28);
  const ct = raw.slice(28);
  const sealed = new Uint8Array(ct.length + tag.length);
  sealed.set(ct, 0);
  sealed.set(tag, ct.length);
  return { iv, sealed };
}

/** Plain two-part concat (the payload slot's ct field is tag ‖ ct, no iv). */
function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * keyVerifier parity with auth.ts: HMAC-SHA256(passwordDerivedKey,
 * "notees-key-check") — over the scrypt-derived wrap key, not the master key,
 * so a wrong password is detectable before attempting the unwrap.
 */
function keyVerifierOf(derivedKeyBytes: Uint8Array): Uint8Array {
  return hmac(sha256, derivedKeyBytes, utf8ToBytes("notees-key-check"));
}

// --- master key (password-wrapped, Standard-Notes-style record) ---------------------

export interface KdfRecord {
  algorithm: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string;
  wrappedMasterKey: string;
  keyVerifier: string;
}

function scryptKeyBytes(password: string, salt: Uint8Array): Uint8Array {
  return scrypt(utf8ToBytes(password), salt, { ...SCRYPT_PARAMS, dkLen: 32 });
}

export function generateMasterKey(): Promise<CryptoKey> {
  // extractable: WebCrypto wrapKey exports the key being wrapped, so the
  // master key must be extractable even though we never call exportKey on it.
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
    "wrapKey",
    "unwrapKey",
  ]);
}

export async function createKdfRecord(
  masterKey: CryptoKey,
  password: string,
): Promise<KdfRecord> {
  const salt = randomBytes(16);
  const wrapKeyBytes = scryptKeyBytes(password, salt);
  const wrapKey = await importAesKey(wrapKeyBytes, ["wrapKey", "unwrapKey"]);
  const iv = randomBytes(12);
  const sealed = new Uint8Array(
    await crypto.subtle.wrapKey("raw", masterKey, wrapKey, { name: "AES-GCM", iv: iv as BufferSource }),
  );
  const { ct, tag } = splitCtTag(sealed);
  return {
    algorithm: "scrypt",
    ...SCRYPT_PARAMS,
    salt: b64uEncode(salt),
    wrappedMasterKey: b64uEncode(joinIvTagCt(iv, tag, ct)),
    keyVerifier: b64uEncode(keyVerifierOf(wrapKeyBytes)),
  };
}

export async function unwrapMasterKey(password: string, record: KdfRecord): Promise<CryptoKey> {
  const salt = b64uDecode(record.salt);
  const wrapKeyBytes = scryptKeyBytes(password, salt);
  // Fail fast on a wrong password: the verifier is over the derived key, so
  // it is checkable before touching the wrapped master key (auth.ts parity).
  if (!constantTimeEqual(keyVerifierOf(wrapKeyBytes), b64uDecode(record.keyVerifier))) {
    throw new Error("master-key verifier mismatch (wrong password)");
  }
  const wrapKey = await importAesKey(wrapKeyBytes, ["wrapKey", "unwrapKey"]);
  const { iv, sealed } = ivTagCtToSealed(b64uDecode(record.wrappedMasterKey));
  return crypto.subtle.unwrapKey(
    "raw",
    sealed as BufferSource,
    wrapKey,
    { name: "AES-GCM", iv: iv as BufferSource },
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
  );
}

// --- workspace keys (master-key-wrapped) ---------------------------------------------

export function generateWorkspaceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function wrapWorkspaceKey(
  masterKey: CryptoKey,
  workspaceKey: CryptoKey,
): Promise<string> {
  const iv = randomBytes(12);
  const sealed = new Uint8Array(
    await crypto.subtle.wrapKey("raw", workspaceKey, masterKey, { name: "AES-GCM", iv: iv as BufferSource }),
  );
  const { ct, tag } = splitCtTag(sealed);
  return b64uEncode(joinIvTagCt(iv, tag, ct));
}

export async function unwrapWorkspaceKey(
  masterKey: CryptoKey,
  wrapped: string,
): Promise<CryptoKey> {
  const { iv, sealed } = ivTagCtToSealed(b64uDecode(wrapped));
  return crypto.subtle.unwrapKey(
    "raw",
    sealed as BufferSource,
    masterKey,
    { name: "AES-GCM", iv: iv as BufferSource },
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

// --- envelope payload encryption (the {"$e": {iv, ct}} slot) -------------------------

export interface EncryptedPayloadSlot {
  $e: { iv: string; ct: string };
}

/** GCM AAD binds ciphertext to its envelope: `${id}.${workspaceId}`. */
export function envelopeAad(envelope: { id: string; workspaceId: string }): string {
  return `${envelope.id}.${envelope.workspaceId}`;
}

export async function encryptPayload(
  workspaceKey: CryptoKey,
  aad: string,
  payload: Record<string, unknown>,
): Promise<EncryptedPayloadSlot> {
  const iv = randomBytes(12);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: utf8ToBytes(aad) as BufferSource },
      workspaceKey,
      utf8ToBytes(JSON.stringify(payload)) as BufferSource,
    ),
  );
  const { ct, tag } = splitCtTag(sealed);
  return { $e: { iv: b64uEncode(iv), ct: b64uEncode(concatBytes(tag, ct)) } };
}

export async function decryptPayload(
  workspaceKey: CryptoKey,
  aad: string,
  slot: EncryptedPayloadSlot,
): Promise<Record<string, unknown>> {
  const iv = b64uDecode(slot.$e.iv);
  const raw = b64uDecode(slot.$e.ct);
  const tag = raw.slice(0, 16);
  const ct = raw.slice(16);
  const sealed = concatBytes(ct, tag); // WebCrypto expects ct ‖ tag
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: utf8ToBytes(aad) as BufferSource },
      workspaceKey,
      sealed as BufferSource,
    ),
  );
  return JSON.parse(bytesToUtf8(plain)) as Record<string, unknown>;
}

/** Seal an envelope's payload; every other field (id, HLC, …) is preserved. */
export async function encryptEnvelope(workspaceKey: CryptoKey, envelope: Envelope): Promise<Envelope> {
  const slot = await encryptPayload(workspaceKey, envelopeAad(envelope), envelope.payload as Record<string, unknown>);
  return { ...envelope, payload: slot };
}

/** Open an envelope's payload; plaintext envelopes pass through unchanged. */
export async function decryptEnvelope(workspaceKey: CryptoKey, envelope: Envelope): Promise<Envelope> {
  if (!isEncryptedPayload(envelope.payload)) return envelope;
  const payload = await decryptPayload(workspaceKey, envelopeAad(envelope), envelope.payload);
  return { ...envelope, payload };
}

// --- byte encryption (snapshot blobs) --------------------------------------------------

export async function encryptBytes(workspaceKey: CryptoKey, bytes: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(12);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, workspaceKey, bytes as BufferSource),
  );
  const { ct, tag } = splitCtTag(sealed);
  return joinIvTagCt(iv, tag, ct); // iv ‖ tag ‖ ct
}

export async function decryptBytes(workspaceKey: CryptoKey, bytes: Uint8Array): Promise<Uint8Array> {
  const { iv, sealed } = ivTagCtToSealed(bytes); // wire tag ‖ ct → WebCrypto ct ‖ tag
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, workspaceKey, sealed as BufferSource),
  );
}

export function importWorkspaceKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export function exportWorkspaceKey(workspaceKey: CryptoKey): Promise<Uint8Array> {
  return crypto.subtle.exportKey("raw", workspaceKey).then((buf) => new Uint8Array(buf));
}
