/**
 * Machine keys — API-key custody (mint-time opt-in, settings → API keys).
 *
 * The recovery-code shape applied to `nk_` tokens: a machine-key token
 * derives a fast-scrypt key (`deriveMachineKey`; the token's ~190 bits are
 * the defense) that wraps the account MASTER key (`wrapWorkspaceKey`
 * verbatim). The server stores only the opaque `{salt, wrappedMaster}`; a
 * client holding the token fetches it back (`GET /api-keys/self/custody`)
 * and unwraps locally — encrypted workspaces with no password, ever.
 *
 * Minting is two-phase because the server generates the token and shows it
 * once: the wrap can only be built AFTER the client sees the token —
 * `createApiKey` (phase 1), then `buildMachineCustodyRecord` +
 * `installApiKeyCustody` (phase 2). The master key for the wrap is
 * re-derived from the password at mint time (the session's working master
 * is non-extractable by design — same pattern as the recovery codes and the
 * change-password card): `unlock` → `unwrapMasterKeyWithBytes` → an
 * extractable re-import, used here and dropped.
 *
 * The client owns all the secrets: the token, the machine key, and the
 * master key never leave this call except as the opaque wrap.
 */

import { b64uEncode, deriveMachineKey, importMasterKey, wrapWorkspaceKey } from "@notees/protocol";

export interface MachineCustodyRecordWire {
  salt: string;
  wrappedMaster: string;
}

/**
 * Build the opaque custody record for a freshly minted key: wrap the master
 * key under a key derived from the (once-shown) token. `masterKey` must be
 * extractable (the re-import from `unwrapMasterKeyWithBytes`' bytes) —
 * `wrapKey` exports the wrapped key. The caller installs the record with
 * `installApiKeyCustody` and forgets the token.
 */
export async function buildMachineCustodyRecord(
  masterKey: CryptoKey,
  token: string,
): Promise<MachineCustodyRecordWire> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const machineKey = await importMasterKey(deriveMachineKey(token, salt));
  return { salt: b64uEncode(salt), wrappedMaster: await wrapWorkspaceKey(machineKey, masterKey) };
}
