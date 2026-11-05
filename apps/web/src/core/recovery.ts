/**
 * Recovery codes — the ONLY account-recovery path (lost password + no code =
 * lost history; the settings and login-screen copy must keep saying so).
 *
 * The client owns all the secrets: it generates the codes, derives each
 * recovery key (fast scrypt), wraps the master key with it (wrapWorkspaceKey
 * verbatim), and ships the server ONLY opaque records — {id = b64u(SHA256
 * (code)), salt, wrappedRecovery, verifier}. The plaintext code, the recovery
 * key, and the master key never leave the device. Redeeming burns the record:
 * the typed code derives the key that unwraps the master, which re-wraps
 * under the new password through the sameness-gated redeem route.
 */

import {
  b64uDecode,
  b64uEncode,
  createKdfRecord,
  deriveRecoveryKey,
  exportWorkspaceKey,
  generateRecoveryCode,
  importMasterKey,
  recoveryCodeIdOf,
  recoveryKeyVerifierOf,
  unwrapMasterKeyWithBytes,
  unwrapWorkspaceKey,
  wrapWorkspaceKey,
} from "@notees/protocol";

import type { RecoveryRecordWire } from "./auth-api.js";
import { fetchRecoveryRecord, installRecoveryCodes, redeemRecovery } from "./auth-api.js";

/** The shipped set size. */
export const RECOVERY_CODE_COUNT = 8;

export interface GeneratedRecoveryCode {
  /** The plaintext code — shown ONCE, stored nowhere. */
  code: string;
  record: RecoveryRecordWire;
}

function randomSalt(): Uint8Array {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return salt;
}

/**
 * Build a fresh set of opaque recovery records wrapping the master key that
 * `password` unwraps from `kdf`. The generated codes ride the return value —
 * the caller shows them once and forgets them.
 */
export async function buildRecoveryRecords(
  password: string,
  kdf: Parameters<typeof unwrapMasterKeyWithBytes>[1],
  count = RECOVERY_CODE_COUNT,
): Promise<GeneratedRecoveryCode[]> {
  const { bytes } = await unwrapMasterKeyWithBytes(password, kdf);
  // The extractable copy exists only inside this call (needed for the wrap).
  const master = await importMasterKey(bytes, true);
  const out: GeneratedRecoveryCode[] = [];
  for (let i = 0; i < count; i += 1) {
    const code = generateRecoveryCode();
    const salt = randomSalt();
    const recoveryKeyBytes = deriveRecoveryKey(code, salt);
    // The recovery key wraps the master — it needs the wrapKey usage
    // (importMasterKey's four-usage roster), not the workspace-key pair.
    const recoveryKey = await importMasterKey(recoveryKeyBytes);
    const wrappedRecovery = await wrapWorkspaceKey(recoveryKey, master);
    out.push({
      code,
      record: {
        id: recoveryCodeIdOf(code),
        salt: b64uEncode(salt),
        wrappedRecovery,
        verifier: b64uEncode(recoveryKeyVerifierOf(recoveryKeyBytes)),
      },
    });
  }
  return out;
}

/** Generate, install, and return the plaintext codes (shown once by the caller). */
export async function generateAndInstallRecoveryCodes(
  serverUrl: string,
  token: string,
  password: string,
  kdf: Parameters<typeof unwrapMasterKeyWithBytes>[1],
): Promise<string[]> {
  const generated = await buildRecoveryRecords(password, kdf);
  await installRecoveryCodes(serverUrl, token, generated.map((g) => g.record));
  return generated.map((g) => g.code);
}

/**
 * The locked-out path: a recovery code unwraps the master key, which
 * re-wraps under the new password; the server burns the code. Throws with
 * the server's message on a wrong/used code (the record is NOT burned for a
 * wrong code — a typo must not cost a one-time code).
 */
export async function redeemRecoveryCode(
  serverUrl: string,
  code: string,
  newPassword: string,
): Promise<void> {
  const id = recoveryCodeIdOf(code);
  const { salt, wrappedRecovery } = await fetchRecoveryRecord(serverUrl, id);
  const recoveryKeyBytes = deriveRecoveryKey(code, b64uDecode(salt));
  // The recovery key unwraps the master — the full usage roster.
  const recoveryKey = await importMasterKey(recoveryKeyBytes);
  // Wrong code → the unwrap throws before anything is burned.
  const master = await unwrapWorkspaceKey(recoveryKey, wrappedRecovery);
  const masterBytes = await exportWorkspaceKey(master);
  // The exportable copy exists only inside this call (needed for the fp).
  const newKdfRecord = await createKdfRecord(await importMasterKey(masterBytes, true), newPassword);
  await redeemRecovery(serverUrl, {
    id,
    verifier: b64uEncode(recoveryKeyVerifierOf(recoveryKeyBytes)),
    newKdfRecord,
  });
}
