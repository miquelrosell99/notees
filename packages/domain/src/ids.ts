/**
 * Deterministic UUID derivation — the single implementation every stack
 * member shares (the server used to own this in apps/server/src/identity.ts;
 * it moved here 2026-10-30 so the packages' pure planners — the workflow
 * op-plan builder (workflows.ts), consumed by the web client AND the CLI —
 * derive byte-identical ids without depending on the server app).
 *
 * The algorithm is unchanged: sha256 over the namespace string, uuid5-style
 * version/variant bits on the digest — byte-identical to the previous
 * apps/server copy, and byte-identical between Node (node:crypto) and the
 * browser (the web build aliases node:crypto to src/shims/node-crypto.ts,
 * digests equal by construction — the @notees/store edges.ts precedent).
 * Pin any derived value you ship with a literal test (workflows.test.ts) —
 * web and CLI must agree forever.
 */

import { createHash } from "node:crypto";

/** Deterministic RFC 4122 uuid (version 5 layout) from arbitrary input. */
export function deriveUuid(namespace: string): string {
  // digest("hex") — the web build aliases node:crypto to a shim whose only
  // digest form is hex; the hex round-trip keeps Node and browser
  // byte-identical by construction.
  const hex = createHash("sha256").update(namespace).digest("hex");
  const digest = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    digest[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  let out = "";
  for (const byte of digest.subarray(0, 16)) {
    out += byte.toString(16).padStart(2, "0");
  }
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20, 32)}`;
}
