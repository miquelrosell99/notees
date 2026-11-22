/**
 * Confidential-share crypto — the password-sealed READ half of confidential
 * sharing (proposal §3.3): the subtree render is sealed client-side with a
 * key derived from a PASSWORD the owner shares out of band (scrypt →
 * AES-GCM — the Bitwarden-Send / Proton link-password pattern). The server
 * stores ONLY the ciphertext + the KDF salt/params; the password never
 * reaches any route, and decryption fails GCM auth locally on a wrong
 * password — never a partial render.
 *
 * The artifact layout rides the plan-08 convention verbatim: random 12-byte
 * IV, blob iv(12) ‖ tag(16) ‖ ct, b64u when carried. sealShareHtml does the
 * AES-GCM given key bytes; this module only owns the password → key-bytes
 * half (noble scrypt — WebCrypto has no scrypt).
 */

import { scrypt } from "@noble/hashes/scrypt";
import { b64uDecode, b64uEncode } from "@notees/protocol";

import { sealShareHtml } from "./sealShare.js";

/** The KDF record carried beside the artifact (the server stores it verbatim). */
export interface ConfidentialKdf {
  algorithm: "scrypt";
  N: number;
  r: number;
  p: number;
}

/** Minting defaults (the protocol's SCRYPT_PARAMS — the same triple the account KDF pins). */
export const CONFIDENTIAL_KDF: ConfidentialKdf = { algorithm: "scrypt", N: 131072, r: 8, p: 1 };

function deriveKeyBytes(password: string, salt: Uint8Array, kdf: ConfidentialKdf): Uint8Array {
  return scrypt(new TextEncoder().encode(password), salt, { N: kdf.N, r: kdf.r, p: kdf.p, dkLen: 32 });
}

/** Seal one self-contained HTML document under a password. */
export async function sealConfidentialHtml(
  html: Uint8Array,
  password: string,
  kdf: ConfidentialKdf = CONFIDENTIAL_KDF,
): Promise<{ artifact: string; salt: string; kdf: ConfidentialKdf }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyBytes = deriveKeyBytes(password, salt, kdf);
  const { artifact } = await sealShareHtml(html, keyBytes);
  return { artifact, salt: b64uEncode(salt), kdf };
}

/**
 * Open a sealed artifact under the out-of-band password. Throws on GCM auth
 * failure (a wrong password) — the caller surfaces "wrong password", never a
 * partial render.
 */
export async function openConfidentialArtifact(
  artifact: string,
  password: string,
  salt: string,
  kdf: ConfidentialKdf,
): Promise<Uint8Array> {
  const bytes = b64uDecode(artifact);
  const iv = bytes.slice(0, 12);
  const tag = bytes.slice(12, 28);
  const ct = bytes.slice(28);
  // WebCrypto's layout is ct ‖ tag — rejoin before decrypt.
  const sealed = new Uint8Array(ct.length + 16);
  sealed.set(ct, 0);
  sealed.set(tag, ct.length);
  const keyBytes = deriveKeyBytes(password, b64uDecode(salt), kdf);
  const key = await crypto.subtle.importKey("raw", keyBytes as BufferSource, "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, sealed as BufferSource),
  );
}
