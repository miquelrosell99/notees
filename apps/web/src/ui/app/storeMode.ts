/**
 * storeMode — the background-store capability probe (framework-free).
 *
 * The worker store needs both `Worker` and OPFS (`navigator.storage
 * getDirectory`); when a capability is missing the app falls back to the
 * in-process store and says so loudly — in the console (naming the missing
 * capability) and in the UI via `InProcessStoreBanner` (rendered off the
 * store mode + `inProcessReason`).
 */

export type StoreMode = "worker" | "in-process";

/**
 * The worker store needs both `Worker` and OPFS (`navigator.storage
 * getDirectory`). When the fallback to in-process mode is
 * taken, say so loudly in the console (naming the missing capability — this
 * is how the profiled Zen session will be diagnosed) and in the UI
 * (`InProcessStoreBanner`, rendered off `storeMode`).
 */
export function detectStoreMode(): StoreMode {
  const hasWorker = typeof Worker !== "undefined";
  const hasOpfs =
    typeof navigator !== "undefined" && navigator.storage?.getDirectory !== undefined;
  if (hasWorker && hasOpfs) return "worker";
  const insecureHint =
    typeof window !== "undefined" && !window.isSecureContext
      ? " — this page is NOT a secure context (plain http on a non-localhost address), so the browser hides OPFS; open the app via its https address or http://localhost to get the background store"
      : "";
  console.warn(
    `[notees] store mode: in-process (Worker: ${hasWorker ? "ok" : "MISSING"}, ` +
      "navigator.storage.getDirectory: " +
      `${hasOpfs ? "ok" : "MISSING"}${insecureHint}) — store reads run on the UI thread`,
  );
  return "in-process";
}

/** Why the in-process fallback happened, phrased for the UI banner. */
export function inProcessReason(): string {
  if (typeof navigator !== "undefined" && navigator.storage?.getDirectory === undefined) {
    if (typeof window !== "undefined" && !window.isSecureContext) {
      return "plain http on a non-localhost address is not a secure context, so the browser hides the OPFS storage the background store needs — use the app's https address or http://localhost";
    }
    return "this browser does not expose OPFS storage (navigator.storage.getDirectory)";
  }
  return "the Web Worker API is unavailable in this browser";
}
