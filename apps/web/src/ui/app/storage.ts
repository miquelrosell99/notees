/**
 * storage — the App's device-local storage seam (module-level, framework-free).
 *
 * The localStorage keys the boot/connect flow persists under, the forgiving
 * read/write/clear helpers (private mode throws; the session just won't
 * persist), and the initial-server-URL resolution (remembered value →
 * same-origin guess → /config.js prefill).
 */

export const STORAGE_KEYS = {
  serverUrl: "notees.serverUrl",
  sessionToken: "notees.sessionToken",
  apiKey: "notees.apiKey",
  workspaceId: "notees.workspaceId",
  /** Device-local workspace created by "Work offline". */
  localWorkspaceId: "notees.localWorkspaceId",
  /** The right rail's workspace card order (device-local UI chrome). */
  railCardOrder: "notees.sidebarCards",
} as const;

export function readStored(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode); the session just won't persist.
  }
}

export function clearStored(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore.
  }
}

/**
 * Initial server URL: a remembered value (localStorage) wins; then the
 * /config.js runtime prefill (window.NOTEES_CONFIG); then a same-host guess —
 * a sync server colocated with the web client conventionally listens on
 * :8377, and `localhost` would point at the user's own device, not the host
 * serving this page (the classic "NetworkError" trap on first connect).
 */
export function initialServerUrl(): string {
  const remembered = readStored(STORAGE_KEYS.serverUrl);
  if (remembered !== "") return remembered;
  // Same-host guess wins over the baked /config.js default: config.js is a
  // deploy-time value that may not match how this browser actually reaches
  // the host, while the guess derives from the page origin itself.
  const guess = sameHostServerUrl();
  if (guess !== "") return guess;
  return window.NOTEES_CONFIG?.serverUrl || "";
}

/**
 * Best guess for a colocated sync server: same host as this page, port 8377.
 * `localhost` entered by hand points at the user's own device, which is the
 * classic first-connect failure — after a failed probe this guess is offered
 * to the user as a suggestion; clicking it is the only path to it (never an
 * automatic re-route).
 */
export function sameHostServerUrl(): string {
  if (typeof location !== "undefined" && location.hostname !== "") {
    // The web container proxies /api/* to the sync service, so the API is
    // ALWAYS same-origin with the page — whatever the scheme (https via the
    // edge, http on loopback/LAN). The manual server field stays for
    // non-standard topologies (remote sync, dev servers).
    return location.origin;
  }
  return "";
}
