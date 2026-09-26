/**
 * Browser shim for `node:crypto` — the only primitive @notees/store uses is
 * `createHash("sha256")` (deterministic edge ids in edges.ts), which the
 * store derives via node:crypto. The browser build replaces the builtin with
 * this module (vite resolve.alias); digests are byte-identical to
 * node:crypto's, so derived state stays convergent. Remove when the store
 * gains an injectable hash function or ships a browser entry.
 */

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

interface Hash {
  update(data: string | Uint8Array): Hash;
  digest(encoding: "hex"): string;
}

class Sha256Hash implements Hash {
  private chunks: Uint8Array[] = [];

  update(data: string | Uint8Array): Hash {
    this.chunks.push(typeof data === "string" ? utf8ToBytes(data) : data);
    return this;
  }

  digest(encoding: "hex"): string {
    if (encoding !== "hex") {
      throw new Error(`node:crypto shim: unsupported digest encoding "${encoding}"`);
    }
    const total = this.chunks.reduce((n, chunk) => n + chunk.length, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    return bytesToHex(sha256(joined));
  }
}

export function createHash(algorithm: string): Hash {
  if (algorithm !== "sha256") {
    throw new Error(`node:crypto shim: unsupported algorithm "${algorithm}"`);
  }
  return new Sha256Hash();
}
