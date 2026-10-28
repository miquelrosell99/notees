/**
 * nodePrefs — the cross-device favorites/recents store (+ the cards
 * scheduler pref).
 *
 * favorites/recents and the cardsAlgorithm choice are UI preferences,
 * so the server-side per-user prefs store is the authority
 * (`GET/PUT /api/me/prefs`) — the operation log stays untouched ("device
 * state is never an op" stands). This module is the main-thread bridge:
 *
 *  - one shared in-memory copy per page (module-level), so the Sidebar, the
 *    page-header star, and every other surface read the same lists without
 *    duplicate GETs;
 *  - boot: `ensureNodePrefsLoaded` fetches the server copy once and writes it
 *    through to the device-local keys (`notees.favorites` / `notees.recents`)
 *    with the legacy broadcasts, so device-local readers (the palette's
 *    Recent section) see the synced source immediately;
 *  - legacy writers (the node context menu's toggle, `recordRecent` /
 *    `removeRecent` in features/sidebar/recentPages.ts) keep writing the
 *    device-local keys and
 *    broadcasting — this store listens and pushes the change to the server
 *    when online (that IS the "migrate the recents write" path: no caller
 *    has to change);
 *  - offline: reads answer from the device copy, writes persist device-locally
 *    and sync on the next successful call (the client's patchPrefs already
 *    falls back this way; `source` says which side answered).
 */

import { useEffect, useState } from "react";

import {
  DEFAULT_CARDS_ALGORITHM,
  MAX_SYNCED_RECENTS,
  mergeFavoriteToggle,
  readDevicePrefList,
  readDevicePrefScalar,
  writeDevicePrefList,
  writeDevicePrefScalar,
  type CardsAlgorithm,
  type PrefsPatch,
  type UserPrefs,
} from "@/core/workspace-client/index.js";

/** The prefs seam both client classes satisfy (structural — tests can fake it). */
export interface PrefsClient {
  getPrefs(): Promise<UserPrefs & { source: "server" | "local" }>;
  patchPrefs(patch: PrefsPatch): Promise<UserPrefs & { source: "server" | "local" }>;
}

export interface NodePrefsState {
  favorites: string[];
  recents: string[];
  /** The memorization-cards scheduler ("sm2" | "fsrs", default "fsrs"). */
  cardsAlgorithm: CardsAlgorithm;
  /** False until the first getPrefs resolved (server or local fallback). */
  loaded: boolean;
}

/** React subscribers + the shared copy. */
const listeners = new Set<() => void>();
let cached: NodePrefsState = {
  ...deviceLists(),
  cardsAlgorithm: readDevicePrefScalar("cardsAlgorithm"),
  loaded: false,
};
let loadedFor: PrefsClient | null = null;
let loadInflight: Promise<void> | null = null;

/** Guards the write-through broadcasts in ensureNodePrefsLoaded (sync dispatches). */
let applyingRemote = false;
/** Coalesces the server push: one patchPrefs at a time, one retry queued. */
let pushRunning = false;
let pushQueued = false;
let activeClient: PrefsClient | null = null;

function deviceLists(): { favorites: string[]; recents: string[] } {
  return { favorites: readDevicePrefList("favorites"), recents: readDevicePrefList("recents") };
}

function notify(): void {
  for (const listener of listeners) listener();
}

function applyLocal(patch: {
  favorites?: string[];
  recents?: string[];
  cardsAlgorithm?: CardsAlgorithm;
}): void {
  if (patch.favorites !== undefined) {
    writeDevicePrefList("favorites", patch.favorites);
    window.dispatchEvent(new Event("notees:favorites"));
  }
  if (patch.recents !== undefined) {
    writeDevicePrefList("recents", patch.recents);
    window.dispatchEvent(new Event("notees:recents"));
  }
  if (patch.cardsAlgorithm !== undefined) {
    writeDevicePrefScalar("cardsAlgorithm", patch.cardsAlgorithm);
    window.dispatchEvent(new Event("notees:prefs"));
  }
  cached = {
    favorites: patch.favorites ?? cached.favorites,
    recents: patch.recents ?? cached.recents,
    cardsAlgorithm: patch.cardsAlgorithm ?? cached.cardsAlgorithm,
    loaded: true,
  };
  notify();
}

/** Push the device lists to the server when they changed since the last push. */
function schedulePush(): void {
  if (activeClient === null || typeof activeClient.patchPrefs !== "function") return;
  if (pushRunning) {
    pushQueued = true;
    return;
  }
  pushRunning = true;
  const snapshot = { ...deviceLists(), cardsAlgorithm: cached.cardsAlgorithm };
  activeClient
    .patchPrefs(snapshot)
    .catch((error: unknown) => {
      // Offline mid-session: the device copy persists; the next event (or
      // reload) retries. Loud enough to diagnose, quiet enough for a plane.
      console.warn("[prefs] server sync failed; kept device-local:", error);
    })
    .finally(() => {
      pushRunning = false;
      if (pushQueued) {
        pushQueued = false;
        schedulePush();
      }
    });
}

/** Union preserving `first`'s order; `second`-only ids append (favorites merge). */
function unionIds(first: readonly string[], second: readonly string[]): string[] {
  return [...first, ...second.filter((id) => !first.includes(id))];
}

/**
 * Boot-time load: fetch the server copy once, then make it the local truth —
 * merged with any device-only ids (a local id the server lacks was written
 * after this device's last successful push, so it lands AHEAD of the server's
 * most-recent-first list; favorites append). A merge that added device-only
 * ids is pushed back so the server converges too. Idempotent per client.
 */
export function ensureNodePrefsLoaded(client: PrefsClient): void {
  activeClient = client;
  if (loadedFor === client && cached.loaded) return;
  if (loadInflight !== null) return;
  // Capture the device truth SYNCHRONOUSLY, before any fetch can resolve and
  // write through: writes that happened before the load starts are in
  // `cached` now; writes during the flight arrive via the legacy broadcast
  // listener (also synchronous). The client's own getPrefs write-through can
  // clobber localStorage mid-flight — the in-memory copy is merge authority.
  cached = { ...deviceLists(), cardsAlgorithm: cached.cardsAlgorithm, loaded: cached.loaded };
  // The scalar is captured like the lists: a setCardsAlgorithm during the
  // flight wins over the server copy that lands after it.
  const bootAlgorithm = cached.cardsAlgorithm;
  // A client without the prefs seam (hand-rolled test doubles): the device
  // lists are the honest answer, never a shell crash.
  if (typeof client.getPrefs !== "function") {
    loadedFor = client;
    cached = { ...cached, loaded: true };
    notify();
    return;
  }
  loadInflight = client
    .getPrefs()
    .then((prefs) => {
      loadedFor = client;
      // Device-only recents are newer than everything the server holds (they
      // were opened after this device's last successful push) — they prepend;
      // favorites order is user-authored, so the server list wins and
      // device-only ids append.
      const deviceOnlyRecents = cached.recents.filter((id) => !prefs.recents.includes(id));
      const merged = {
        favorites: unionIds(prefs.favorites, cached.favorites),
        recents: [...deviceOnlyRecents, ...prefs.recents].slice(0, MAX_SYNCED_RECENTS),
      };
      const mergedUpstream =
        JSON.stringify(merged.favorites) !== JSON.stringify(prefs.favorites) ||
        JSON.stringify(merged.recents) !== JSON.stringify(prefs.recents);
      const algorithmChanged = cached.cardsAlgorithm !== bootAlgorithm;
      applyingRemote = true;
      try {
        // Server won (plus the merge): write through to the device keys +
        // legacy broadcasts (the guard keeps our own listener from pushing
        // it straight back). The scalar rides along — server wins on load,
        // unless a local set won the race, in which case it is pushed back.
        applyLocal({
          ...merged,
          cardsAlgorithm: algorithmChanged ? cached.cardsAlgorithm : prefs.cardsAlgorithm,
        });
      } finally {
        applyingRemote = false;
      }
      if (mergedUpstream || algorithmChanged) schedulePush();
    })
    .catch((error: unknown) => {
      // Even the local fallback failed to resolve — stay device-local.
      console.warn("[prefs] initial load failed; device-local lists stand:", error);
      cached = { ...deviceLists(), cardsAlgorithm: cached.cardsAlgorithm, loaded: true };
      notify();
    })
    .finally(() => {
      loadInflight = null;
    });
}

/** Star toggle, server-synced. Optimistic: the local copy updates first. */
export function toggleNodeFavorite(client: PrefsClient | null, id: string): void {
  const next = mergeFavoriteToggle(cached.favorites, id);
  applyLocal({ favorites: next });
  if (client !== null) {
    activeClient = client;
    schedulePush();
  }
}

/**
 * Reorder the favorites list (the sidebar's drag sort),
 * server-synced. Optimistic like the star toggle; favorites order is
 * user-authored, so the pushed array wins everywhere.
 */
export function reorderNodeFavorites(client: PrefsClient | null, orderedIds: string[]): void {
  applyLocal({ favorites: orderedIds });
  if (client !== null) {
    activeClient = client;
    schedulePush();
  }
}

/** Remove a recent, server-synced (the sidebar row menu's Remove action). */
export function removeSyncedRecent(client: PrefsClient | null, id: string): void {
  const next = cached.recents.filter((entry) => entry !== id);
  applyLocal({ recents: next });
  if (client !== null) {
    activeClient = client;
    schedulePush();
  }
}

/**
 * The memorization-cards scheduler for this user ("sm2" | "fsrs"). The shared
 * copy is seeded from the device-local key at module load and converged with
 * the server copy at boot — this never blocks on a fetch.
 */
export function getCardsAlgorithm(): Promise<CardsAlgorithm> {
  return Promise.resolve(cached.cardsAlgorithm);
}

/**
 * Set the scheduler choice, server-synced. Optimistic: the device-local key
 * (`notees.prefs.cardsAlgorithm`) and the shared copy update first, then the
 * patch rides to the server when the boot-time client is online (offline:
 * the write persists device-locally and the next successful call syncs it).
 * Broadcasts `notees:prefs` so any surface holding the value re-reads.
 */
export function setCardsAlgorithm(algorithm: CardsAlgorithm): void {
  applyLocal({ cardsAlgorithm: algorithm });
  if (activeClient !== null && typeof activeClient.patchPrefs === "function") {
    activeClient.patchPrefs({ cardsAlgorithm: algorithm }).catch((error: unknown) => {
      console.warn("[prefs] cardsAlgorithm sync failed; kept device-local:", error);
    });
  }
}

/** Test seam: reset the module store (clears caches + the loaded-client key). */
export function resetNodePrefsForTests(): void {
  cached = {
    favorites: [],
    recents: [],
    cardsAlgorithm: DEFAULT_CARDS_ALGORITHM,
    loaded: false,
  };
  loadedFor = null;
  activeClient = null;
  loadInflight = null;
}

/** The hook: every surface reads the same shared copy; re-renders on change. */
export function useNodePrefs(client: PrefsClient | null): NodePrefsState {
  const [state, setState] = useState<NodePrefsState>(cached);
  useEffect(() => {
    const refresh = () => setState(cached);
    listeners.add(refresh);
    // Legacy device-local writers (node menu toggle, recordRecent) broadcast
    // these — adopt their write and sync it upward.
    const onLegacy = () => {
      if (applyingRemote) return;
      const device = deviceLists();
      cached = { ...device, cardsAlgorithm: cached.cardsAlgorithm, loaded: true };
      notify();
      schedulePush();
    };
    window.addEventListener("notees:favorites", onLegacy);
    window.addEventListener("notees:recents", onLegacy);
    if (client !== null) ensureNodePrefsLoaded(client);
    refresh();
    return () => {
      listeners.delete(refresh);
      window.removeEventListener("notees:favorites", onLegacy);
      window.removeEventListener("notees:recents", onLegacy);
    };
  }, [client]);
  return state;
}
