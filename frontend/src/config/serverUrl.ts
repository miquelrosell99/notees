/**
 * Runtime server configuration (local-first split).
 *
 * The client can run in three connection modes:
 * - `local`       — no server configured; the app must not call `/api/*` or
 *                   poll health (later tasks gate on this mode).
 * - `connected`   — a server is configured (or the app is served same-origin)
 *                   and the health mechanism reports it reachable.
 * - `unreachable` — a server is configured but the health mechanism reports
 *                   it down (today's warning-banner behavior).
 *
 * The setting is persisted in localStorage under `notees.serverUrl`:
 * - key absent        → same-origin default (current all-in-one behavior;
 *                       byte-identical to before this module existed)
 * - key set to `''`   → explicit local mode (user cleared it, or a static
 *                       deployment opted out)
 * - key set to a URL  → remote server origin, e.g. `https://notes.example.com`
 *
 * The value is read once at module init; `setServerUrl` persists and updates
 * the cache, but modules that already resolved their base URL keep the old
 * value — callers should trigger a full reload after changing it.
 */
import { getLogger } from '@/utils/logger';

const log = getLogger('config');

export type ConnectionMode = 'local' | 'connected' | 'unreachable';

export const SERVER_URL_STORAGE_KEY = 'notees.serverUrl';

/** Raw stored value: `null` = absent (same-origin default), `''` = explicit local mode. */
let storedServerUrl: string | null = readStoredServerUrl();

declare global {
  interface Window {
    /**
     * Optional runtime default injected by static deployments via
     * `/config.js` (see Dockerfile.web). Used only when no localStorage
     * setting exists; an explicit setting always wins.
     */
    __NOTEES_SERVER_URL__?: string;
  }
}

function readStoredServerUrl(): string | null {
  try {
    const stored = localStorage.getItem(SERVER_URL_STORAGE_KEY);
    if (stored !== null) {
      return stored;
    }
  } catch {
    // localStorage unavailable (worker context, disabled storage) — fall
    // through to the bootstrap default.
  }
  // Static web-only image: /config.js sets the deployment default
  // (`''` = local mode, a URL = preconfigured server).
  if (typeof window !== 'undefined' && typeof window.__NOTEES_SERVER_URL__ === 'string') {
    return window.__NOTEES_SERVER_URL__;
  }
  return null;
}

/**
 * Normalize user input: trim whitespace and trailing slashes, require an
 * absolute http(s) URL. Throws on invalid non-empty input.
 */
function normalizeServerUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid server URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Server URL must use http(s): ${url}`);
  }
  return trimmed;
}

/**
 * The configured server origin, or `null` when none is configured.
 * `null` means "same-origin default" when the key is absent, and "no server"
 * when the key was explicitly cleared — use `getConnectionMode` to
 * distinguish the two.
 */
export function getServerUrl(): string | null {
  if (storedServerUrl === null || storedServerUrl === '') {
    return null;
  }
  try {
    return normalizeServerUrl(storedServerUrl);
  } catch {
    // A hand-edited or corrupted value must not lock the user out; treat it
    // as the same-origin default.
    log.warn('Ignoring invalid stored server URL', storedServerUrl);
    return null;
  }
}

/**
 * Persist the server URL. Pass `null` (or an empty/whitespace string) to
 * clear it — that is an explicit opt into local mode, distinct from the
 * same-origin default of a never-touched setting.
 *
 * Throws if the URL is non-empty and not a valid absolute http(s) URL.
 * Callers should trigger a full reload after this so every module re-resolves
 * its base URL.
 */
export function setServerUrl(url: string | null): void {
  if (url === null || url.trim() === '') {
    storedServerUrl = '';
    localStorage.setItem(SERVER_URL_STORAGE_KEY, '');
    return;
  }
  const normalized = normalizeServerUrl(url);
  storedServerUrl = normalized;
  localStorage.setItem(SERVER_URL_STORAGE_KEY, normalized);
}

/**
 * Axios base URL: `/api` same-origin when no server is configured, or
 * `<serverUrl>/api` when one is.
 */
export function getApiBaseUrl(): string {
  const serverUrl = getServerUrl();
  return serverUrl ? `${serverUrl}/api` : '/api';
}

/**
 * Derive the connection mode from the stored setting plus the health state
 * tracked by `useConnectionStore` (`healthy`: `null` = first check pending,
 * `true` = reachable, `false` = down).
 */
export function getConnectionMode(healthy: boolean | null): ConnectionMode {
  if (storedServerUrl === '') {
    return 'local';
  }
  return healthy === false ? 'unreachable' : 'connected';
}
