/**
 * Runtime configuration injected by /config.js (served ahead of the bundle in
 * index.html). The web container entrypoint writes it from NOTEES_SERVER_URL;
 * absent the file, window.NOTEES_CONFIG stays undefined and App falls back to
 * the manual bootstrap form + localStorage.
 */

export {};

declare global {
  interface Window {
    NOTEES_CONFIG?: {
      serverUrl?: string;
    };
  }
}
