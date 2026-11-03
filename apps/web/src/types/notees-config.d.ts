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
       * E2EE kill switch: workspace keying runs ONLY when exactly "on".
       * Default (absent/any other value) = off = keyless plaintext behavior,
       * until the sibling clients converge on the encrypted-fixture lockstep.
       */
      e2ee?: string;
    };
  }
}
