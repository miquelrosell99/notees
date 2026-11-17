import browser from "webextension-polyfill";
import {
  ConnectorSettings,
  loadSettings,
  normalizeServerUrl,
  saveSettings,
} from "../shared/settings";
import { probeServer } from "../background/probe";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

function setStatus(text: string, kind: "ok" | "err" | ""): void {
  const statusEl = $("status");
  statusEl.textContent = text;
  statusEl.className = kind;
}

async function readForm(): Promise<ConnectorSettings> {
  const serverUrl = normalizeServerUrl(($("server-url") as HTMLInputElement).value);
  return {
    serverUrl,
    apiKey: ($("api-key") as HTMLInputElement).value.trim(),
    features: {
      bibliography: ($("feat-bibliography") as HTMLInputElement).checked,
      readLater: ($("feat-readlater") as HTMLInputElement).checked,
    },
  };
}

/** Grant the extension access to exactly the configured origin. */
async function requestOriginPermission(serverUrl: string): Promise<boolean> {
  if (!serverUrl) return false;
  try {
    return await browser.permissions.request({ origins: [`${serverUrl}/*`] });
  } catch {
    return false;
  }
}

async function persist(settings: ConnectorSettings): Promise<void> {
  await saveSettings(settings);
  await browser.runtime.sendMessage({
    source: "notees-connector",
    type: "settings-changed",
    features: settings.features,
  }).catch(() => undefined); // background may be asleep; menus rebuild on wake via storage.onChanged too
}

async function init(): Promise<void> {
  const settings = await loadSettings();
  ($("server-url") as HTMLInputElement).value = settings.serverUrl;
  ($("api-key") as HTMLInputElement).value = settings.apiKey;
  ($("feat-bibliography") as HTMLInputElement).checked = settings.features.bibliography;
  ($("feat-readlater") as HTMLInputElement).checked = settings.features.readLater;

  $("settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    let settings: ConnectorSettings;
    try {
      settings = await readForm();
    } catch (err) {
      setStatus((err as Error).message, "err");
      return;
    }
    if (settings.serverUrl) {
      const granted = await requestOriginPermission(settings.serverUrl);
      if (!granted) setStatus("Origin permission denied — tab relay and REST capture will not work.", "err");
    }
    await persist(settings);
    setStatus("Saved.", "ok");
  });

  $("test").addEventListener("click", async () => {
    let settings: ConnectorSettings;
    try {
      settings = await readForm();
    } catch (err) {
      setStatus((err as Error).message, "err");
      return;
    }
    if (!settings.serverUrl || !settings.apiKey) {
      setStatus("Enter the server URL and an API key to test the connection.", "err");
      return;
    }
    setStatus("Probing…", "");
    const result = await probeServer(settings.serverUrl, settings.apiKey);
    setStatus(
      result.ok
        ? "Connection OK — the server accepted the API key."
        : result.error === "unauthorized"
          ? "The server rejected the API key (401/403)."
          : result.error === "not-notees"
            ? "The server answered, but it is not a Notees sync server."
            : "Could not reach the server — check the URL and network.",
      result.ok ? "ok" : "err",
    );
  });
}

declare global {
  interface Window {
    __noteesOptionsInit?: boolean;
  }
}

export { init };

// Self-initialize in the real page; the guard keeps jsdom tests able to re-init per case.
if (!window.__noteesOptionsInit) {
  window.__noteesOptionsInit = true;
  void init();
}
