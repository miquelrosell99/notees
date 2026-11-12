/**
 * The prefs wire shape (plan 07): ONE opaque blob riding GET/PUT /me/prefs.
 *
 * - WRAPPED: `b64u(iv ‖ tag ‖ ct)` of the prefs JSON, sealed with the
 *   account master key (`encryptBytes` — the master key carries
 *   encrypt/decrypt usages). Opaque to the server; unwrapped after unlock.
 * - UNWRAPPED: the prefs JSON verbatim — the keyless self-host form, exactly
 *   what a session without a master key (or a legacy migration row) stores.
 *
 * The wrap/unwrap is transparent: with no master key in memory the blob
 * passes through unwrapped (keyless sessions keep working); with a key, a
 * decrypt failure falls back to reading the unwrapped form (a row written
 * keyless). MAIN-THREAD ONLY — the custody module lives there (the worker
 * never sees the master key).
 */

import { b64uDecode, b64uEncode, decryptBytes, encryptBytes } from "@notees/protocol";

import { currentMasterKey } from "./crypto-custody.js";
import type { UserPrefs } from "./workspace-client/prefs.js";

export interface PrefsWire {
  v: 1;
  favorites: string[];
  recents: string[];
  cardsAlgorithm: "sm2" | "fsrs";
  adsApiToken: string;
}

/** The prefs object → the unwrapped wire JSON. */
export function serializePrefs(prefs: UserPrefs): string {
  const wire: PrefsWire = {
    v: 1,
    favorites: prefs.favorites,
    recents: prefs.recents,
    cardsAlgorithm: prefs.cardsAlgorithm,
    adsApiToken: prefs.adsApiToken,
  };
  return JSON.stringify(wire);
}

/** Parse the unwrapped wire JSON back into a prefs object (defaults on drift). */
export function parsePrefsWire(serialized: string): UserPrefs {
  try {
    const wire = JSON.parse(serialized) as Partial<PrefsWire>;
    return {
      favorites: Array.isArray(wire.favorites) ? wire.favorites.filter((id) => typeof id === "string") : [],
      recents: Array.isArray(wire.recents) ? wire.recents.filter((id) => typeof id === "string") : [],
      cardsAlgorithm: wire.cardsAlgorithm === "sm2" ? "sm2" : "fsrs",
      adsApiToken: typeof wire.adsApiToken === "string" ? wire.adsApiToken : "",
    };
  } catch {
    return { favorites: [], recents: [], cardsAlgorithm: "fsrs", adsApiToken: "" };
  }
}

/** Store form of the wire JSON: sealed when a master key is in memory, verbatim otherwise. */
export async function sealPrefsBlob(serialized: string): Promise<string> {
  const master = currentMasterKey();
  if (master === null) return serialized;
  const sealed = await encryptBytes(master.key, new TextEncoder().encode(serialized));
  return b64uEncode(sealed);
}

/** Read form: opens a wrapped blob with the master key; unwrapped/legacy passes through. */
export async function openPrefsBlob(blob: string): Promise<string> {
  const master = currentMasterKey();
  if (master === null) return blob;
  try {
    const plain = await decryptBytes(master.key, b64uDecode(blob));
    return new TextDecoder().decode(plain);
  } catch {
    return blob; // unwrapped (keyless-written or legacy) — parse as JSON
  }
}
