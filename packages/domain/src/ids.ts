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
  const digest = createHash("sha256").update(namespace).digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
