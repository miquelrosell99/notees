import browser from "webextension-polyfill";

export interface ConnectorSettings {
  /** Normalized origin, e.g. "https://host" — no path, no trailing slash. */
  serverUrl: string;
  /** "nk_…" scoped key; "" when unset. Sent ONLY to serverUrl. */
  apiKey: string;
  features: { bibliography: boolean; readLater: boolean };
}

export const DEFAULT_SETTINGS: ConnectorSettings = {
  serverUrl: "",
  apiKey: "",
  features: { bibliography: true, readLater: true },
};

const STORAGE_KEY = "settings";

/**
 * Collapses "https://host/", "https://host", " https://host/app "
 * to the bare origin "https://host". Throws on garbage or non-http(s) input,
 * and on credentials embedded in the URL (URL.origin would silently drop them).
 */
export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Server URL must include the scheme, e.g. https://example.com — got "${raw}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Server URL must be http(s) — got "${url.protocol}"`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`Server URL must not include credentials — got "${raw}"`);
  }
  return url.origin;
}

export async function loadSettings(): Promise<ConnectorSettings> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  const value = (stored[STORAGE_KEY] ?? {}) as Partial<ConnectorSettings>;
  return {
    serverUrl: typeof value.serverUrl === "string" ? value.serverUrl : "",
    apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
    features: {
      bibliography: value.features?.bibliography ?? DEFAULT_SETTINGS.features.bibliography,
      readLater: value.features?.readLater ?? DEFAULT_SETTINGS.features.readLater,
    },
  };
}

export async function saveSettings(settings: ConnectorSettings): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: settings });
}
