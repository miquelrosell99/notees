/**
 * Asset-byte sealing for the CAS channel (plan 05).
 *
 * The asset REST channel never enters the worker (asset-transport is pure
 * fetch on the main thread), and the custody cache is main-thread, so both
 * store modes resolve keys here. Layout contract (ports must match for
 * cross-client asset sharing): the sealed blob is `tag(16) ‖ ct` with a
 * per-asset random 12-byte IV that lives OUTSIDE the blob as server-side
 * asset metadata (never wire/op-log state) — `encryptAssetBytes` in
 * `@notees/protocol`.
 *
 * Keyless sessions are legal (mixed log): uploads without a key stay
 * plaintext; downloads of sealed assets without a key throw
 * `AssetSealedLockedError` so callers render the honest fallback chip,
 * never a corrupted render or a hard failure.
 */

import {
  b64uDecode,
  b64uEncode,
  decryptAssetBytes,
  encryptAssetBytes,
  importWorkspaceKey,
} from "@notees/protocol";

import { currentMasterKey, ensureWorkspaceKey, getCachedWorkspaceKey } from "../crypto-custody.js";

/** A sealed asset download with no key available: callers show the fallback. */
export class AssetSealedLockedError extends Error {
  constructor() {
    super("this asset is sealed and this session has no key — unlock the workspace to open it");
    this.name = "AssetSealedLockedError";
  }
}

export interface SealedAssetUpload {
  bytes: Uint8Array;
  /** Multipart declarations for the server's encrypted arm; null = plaintext. */
  fields: { encrypted: string; mimeType: string; iv: string } | null;
}

/**
 * Encrypt at upload when the workspace key resolves; otherwise today's
 * plaintext path (bytes unchanged, no fields). Key-resolution failure also
 * degrades to plaintext — a keyless upload is legal, a failed one must not
 * lose the user's file.
 */
export async function sealAssetIfKeyed(
  serverUrl: string,
  token: string,
  workspaceId: string,
  bytes: Uint8Array,
  mimeType: string,
): Promise<SealedAssetUpload> {
  const master = currentMasterKey();
  if (master === null) return { bytes, fields: null };
  try {
    const key = await importWorkspaceKey(await ensureWorkspaceKey(serverUrl, token, workspaceId, master));
    const { iv, blob } = await encryptAssetBytes(key, bytes);
    return { bytes: blob, fields: { encrypted: "1", mimeType, iv: b64uEncode(iv) } };
  } catch {
    return { bytes, fields: null };
  }
}

/**
 * Open a downloaded asset: plaintext (iv null) passes through unchanged;
 * sealed bytes decrypt with the cached workspace key; sealed without a key
 * throws `AssetSealedLockedError`; a decrypt failure throws an honest error
 * — callers must never render ciphertext.
 */
export async function openAssetIfSealed(
  workspaceId: string,
  iv: string | null,
  blob: Uint8Array,
): Promise<Uint8Array> {
  if (iv === null) return blob;
  const raw = await getCachedWorkspaceKey(workspaceId);
  if (raw === null) throw new AssetSealedLockedError();
  const key = await importWorkspaceKey(raw);
  try {
    return await decryptAssetBytes(key, b64uDecode(iv), blob);
  } catch (error) {
    throw new Error(
      `asset decryption failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
