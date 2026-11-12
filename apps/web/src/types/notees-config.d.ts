/**
 * Runtime configuration injected by /config.js (served ahead of the bundle in
 * index.html). The web container entrypoint writes it from NOTEES_SERVER_URL
 * and NOTEES_E2EE; absent the file, window.NOTEES_CONFIG stays undefined and
 * App falls back to the manual bootstrap form + localStorage.
 */

export {};

declare global {
  interface Window {
    NOTEES_CONFIG?: {
      serverUrl?: string;
      /**
       * INERT — the E2EE kill switch retired: workspace keying is
       * unconditional and nothing reads this flag anymore. The field stays
       * typed so the container entrypoint's /config.js keeps writing it
       * without a shape change (compat).
       */
      e2ee?: string;
    };
  }
}
