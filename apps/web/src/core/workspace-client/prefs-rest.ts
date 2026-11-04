/**
 * The shared /api/me/prefs REST core both clients' getPrefs/patchPrefs ride:
 * GET/PUT → blob unwrap (account master key when in memory) → device-cache
 * write-through (so device-local readers — sidebar lists, palette Recent —
 * see the same source). Resolves null when the server is unreachable or
 * answers non-ok; each caller's prologue (REST-config check, operator-key
 * probe, offline fallback) stays at the call site.
 * MAIN-THREAD ONLY — pulls prefs-wire → crypto custody (the worker never
 * sees the master key).
 */

import { openPrefsBlob, parsePrefsWire, sealPrefsBlob, serializePrefs } from "../prefs-wire.js";
import { writeDevicePrefList, writeDevicePrefScalar, type UserPrefs } from "./prefs.js";

/** The server answer → unwrapped prefs, written through to the device cache. */
async function unwrapAndCache(body: unknown): Promise<UserPrefs> {
  const blob = (body as { blob?: unknown }).blob;
  const prefs = parsePrefsWire(await openPrefsBlob(typeof blob === "string" ? blob : ""));
  writeDevicePrefList("favorites", prefs.favorites);
  writeDevicePrefList("recents", prefs.recents);
  writeDevicePrefScalar("cardsAlgorithm", prefs.cardsAlgorithm);
  return prefs;
}

/**
 * GET /api/me/prefs (session or API-key credential). Null when the server
 * is unreachable or answers non-ok — the caller's local cache is the honest
 * offline answer.
 */
export async function pullServerPrefs(serverUrl: string, apiKey: string): Promise<UserPrefs | null> {
  try {
    const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/me/prefs`, {
      headers: { "X-API-Key": apiKey },
    });
    if (!response.ok) return null;
    return await unwrapAndCache(await response.json());
  } catch {
    return null;
  }
}

/**
 * PUT /api/me/prefs (merge patch; each present list replaces its column
 * wholesale, a present cardsAlgorithm replaces the scalar). The sealed blob
 * rides the account master key when one is in memory, verbatim otherwise.
 * Null when the server is unreachable or answers non-ok — the caller's
 * local write already landed.
 */
export async function pushServerPrefs(
  serverUrl: string,
  apiKey: string,
  merged: UserPrefs,
): Promise<UserPrefs | null> {
  try {
    const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/me/prefs`, {
      method: "PUT",
      headers: { "X-API-Key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ blob: await sealPrefsBlob(serializePrefs(merged)) }),
    });
    if (!response.ok) return null;
    return await unwrapAndCache(await response.json());
  } catch {
    return null;
  }
}
