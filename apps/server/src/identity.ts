/**
 * Single-user identity: the API key is the principal. The actor id is
 * derived deterministically from the key (uuid5-style over sha256) so the
 * same key maps to the same actor across restarts (the actor is derived
 * from the authenticated principal, never from client claims).
 */

import { timingSafeEqual } from "node:crypto";

import { deriveUuid } from "@notees/domain";

import { isValidApiKeyShape } from "./config.js";

export function constantTimeKeyEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Equalize work even on length mismatch.
    timingSafeEqual(a, a);
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function isProvisionedKeyShape(key: string): boolean {
  return isValidApiKeyShape(key);
}

/** Deterministic RFC 4122 uuid (version 5 layout) from arbitrary input.
 *  The implementation lives in @notees/domain (packages/domain/src/ids.ts) —
 *  one shared derivation for server, web (browser shim), and CLI; re-exported
 *  here so existing server call sites keep working. */
export { deriveUuid };

/** The actor identity for the single API key (deterministic per key). */
export function actorIdForKey(apiKey: string): string {
  return deriveUuid(`notees:actor:${apiKey}`);
}

/** The actor identity for an account: stable per user across sessions. */
export function actorIdForUser(userId: string): string {
  return deriveUuid(`notees:actor:user:${userId}`);
}

/**
 * The authenticated principal of a request. The API key is the
 * machine/operator principal (CLI, owned devices) with unrestricted access;
 * user principals are accounts authorized per workspace via membership.
 */
export type Principal =
  | { kind: "apikey"; actorId: string }
  | { kind: "user"; userId: string; actorId: string; isAdmin: boolean };

/** Stable default workspace for the single-user object/assets API. */
export function defaultWorkspaceId(): string {
  return deriveUuid("notees:workspace:default");
}
