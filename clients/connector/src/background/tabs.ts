import browser from "webextension-polyfill";
import type { Tabs } from "webextension-polyfill";
import { normalizeServerUrl } from "../shared/settings";

function sameOrigin(url: string | undefined, serverOrigin: string): boolean {
  if (!url) return false;
  try {
    return new URL(url).origin === serverOrigin;
  } catch {
    return false; // about:, moz-extension:, etc.
  }
}

/**
 * A Notees tab = any tab whose URL origin equals the configured server origin.
 * The configured value is normalized the same way the options page stores it
 * (bare origin), so "https://host/", " https://host/app " also match.
 */
export async function findNoteesTab(serverUrl: string): Promise<Tabs.Tab | null> {
  let serverOrigin: string;
  try {
    serverOrigin = normalizeServerUrl(serverUrl);
  } catch {
    return null; // garbage input — same answer as "no matching tab"
  }
  if (!serverOrigin) return null;
  const tabs = await browser.tabs.query({});
  return tabs.find((t) => sameOrigin(t.url, serverOrigin)) ?? null;
}

/**
 * Injects the postMessage bridge into a server-origin tab.
 * The bridge itself is idempotent (Task 7) — safe to call on every capture,
 * and duplicate injections raise no error here.
 */
export async function ensureBridge(tabId: number): Promise<void> {
  await browser.tabs.executeScript(tabId, { file: "content-bridge.js" });
}
