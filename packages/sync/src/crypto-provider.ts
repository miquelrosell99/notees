/**
 * The stock EnvelopeCrypto: protocol envelope/byte encryption closed over a
 * workspace key (WebCrypto CryptoKey). Key custody lives in the client — the
 * engine only ever sees this provider interface.
 */

import { decryptBytes, decryptEnvelope, encryptBytes, encryptEnvelope } from "@notees/protocol";
import type { EnvelopeCrypto } from "./types.js";

// WebCrypto's CryptoKey is ambient in the DOM lib but not under @types/node 20
// (lib ES2022, no DOM) — derive it from the declared global `crypto`.
type CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/** An EnvelopeCrypto backed by a workspace key (WebCrypto CryptoKey). */
export function keyCryptoProvider(workspaceKey: CryptoKey): EnvelopeCrypto {
  return {
    encryptEnvelope: (envelope) => encryptEnvelope(workspaceKey, envelope),
    decryptEnvelope: (envelope) => decryptEnvelope(workspaceKey, envelope),
    encryptSnapshot: (bytes) => encryptBytes(workspaceKey, bytes),
    decryptSnapshot: (bytes) => decryptBytes(workspaceKey, bytes),
  };
}
