/**
 * The client-side actor → user resolution surface for node attribution
 * (created-by / last-edited-by). The relay records actorId → userId at first
 * authenticated ingest; GET /api/actors exposes the registry joined with the
 * users table. This module fetches it ONCE per server+credential, caches it
 * in-module, and hands React a subscription (useSyncExternalStore).
 *
 * Degradation contract: unreachable server / non-ok answer → the cache stays
 * null and every attribution row falls back to the raw actorId prefix (the
 * PropertyHistoryModal precedent). Actor ids with no claim (operator-key
 * writes, legacy devices) read the same way.
 */

import { useSyncExternalStore } from "react";

export interface ActorIdentity {
  actorId: string;
  userId: string;
  email: string;
  displayName: string | null;
}

type Registry = ReadonlyMap<string, ActorIdentity>;

let cache: Registry | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The cached registry (null until the first successful prime). */
function snapshot(): Registry | null {
  return cache;
}

/** React seam: re-renders when a prime lands. Null = fallback rendering. */
export function useActorRegistry(): Registry | null {
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * GET /api/actors once; the map replaces the cache and notifies subscribers.
 * Fire-and-forget by design — the UI renders with fallbacks until it lands.
 * Pass the session/api-key credential; an operator key 401s and leaves the
 * cache untouched.
 */
export function primeActorRegistry(serverUrl: string, apiKey: string): void {
  void (async () => {
    try {
      const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/actors`, {
        headers: { "X-API-Key": apiKey },
      });
      if (!response.ok) return;
      const body = (await response.json()) as { actors?: ActorIdentity[] };
      if (!Array.isArray(body.actors)) return;
      cache = new Map(body.actors.map((actor) => [actor.actorId, actor]));
      emit();
    } catch {
      // Offline / unreachable: the raw-actorId fallback stands.
    }
  })();
}

/** The display name for an attribution actor: the registry's displayName (or
 * email) when claimed, else the actorId's uuid prefix — never null, so a row
 * with an actor always names SOMEONE honestly.
 */
export function actorDisplayName(actorId: string, registry: Registry | null): string {
  const identity = registry?.get(actorId);
  if (identity !== undefined) {
    return identity.displayName ?? identity.email;
  }
  return `${actorId.slice(0, 8)}…`;
}

/** Test seam: clears the module cache and notifies subscribers. */
export function __resetActorRegistryForTests(): void {
  cache = null;
  emit();
}
