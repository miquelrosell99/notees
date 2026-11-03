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
import { utf8ToBytes } from "@noble/hashes/utils";

// WebCrypto type names (CryptoKey, KeyUsage, BufferSource) are ambient in the
// DOM lib, but this package compiles against lib ES2022 + @types/node 20,
// which keeps them under the `webcrypto` namespace only. Derive them from the
// already-declared global `crypto` so the module stays runtime-agnostic
// (browser + Node) with no `node:crypto` import.
type Subtle = typeof crypto.subtle;
type CryptoKey = Awaited<ReturnType<Subtle["importKey"]>>;
type KeyUsage = Parameters<Subtle["importKey"]>[4][number];
type BufferSource = Parameters<Subtle["importKey"]>[1];

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
