import browser from "webextension-polyfill";
import type { Tabs } from "webextension-polyfill";
import { SOURCE } from "../shared/source";
import { CaptureMode } from "../shared/capture-types";
import { ConnectorSettings, loadSettings } from "../shared/settings";
import { buildMenus, MENU_READLATER_ID, MENU_SOURCE_ID } from "./menus";
import { performCapture } from "./capture-command";
import { createTransport } from "./transport";
import { ensureBridge, findNoteesTab } from "./tabs";
import { captureViaRelay } from "./relay";
import { captureViaRest } from "./rest-client";

// Task 10 transport, wired with the real deps: Notees tab relay preferred,
// direct REST fallback. ensureBridge rejections (e.g. tab closed mid-capture)
// are handled inside captureWithTransport — never swallowed here.
const transport = createTransport({ findNoteesTab, ensureBridge, captureViaRelay, captureViaRest });

async function currentSettings(): Promise<ConnectorSettings> {
  return loadSettings();
}

// Event listeners can't await; unexpected throws (never transport outcomes —
// those come back as CaptureOutcome) are logged, not left as unhandled rejections.
function fire(promise: Promise<void>): void {
  void promise.catch((err) => console.error("notees-connector background:", err));
}

async function captureDefault(tab: Tabs.Tab | undefined): Promise<void> {
  if (!tab) return;
  const settings = await currentSettings();
  // Default follows the toggles: bibliography first, read-later second. With
  // both off the picked mode fails performCapture's toggle check, which
  // notifies the user to enable one.
  const mode: CaptureMode = settings.features.bibliography ? "source" : "readlater";
  await performCapture(mode, tab, settings, transport);
}

// Toolbar button + Ctrl+Alt+S (commands._execute_browser_action, manifest).
browser.browserAction.onClicked.addListener((tab) => fire(captureDefault(tab)));

// Context menus.
browser.runtime.onInstalled.addListener(() => {
  fire(currentSettings().then((s) => buildMenus(s.features)));
});
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings?.newValue) {
    buildMenus((changes.settings.newValue as ConnectorSettings).features);
  }
});
browser.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  const mode: CaptureMode | null =
    info.menuItemId === MENU_SOURCE_ID ? "source"
    : info.menuItemId === MENU_READLATER_ID ? "readlater"
    : null;
  if (!mode) return;
  // "link" context: capture the link target instead of the page — and flag it,
  // so the page's own citation meta is never attached to the link's URL.
  const isLink = Boolean(info.linkUrl);
  const target = isLink ? { ...tab, url: info.linkUrl, title: info.linkText ?? tab.title } : tab;
  fire(currentSettings().then((s) => performCapture(mode, target, s, transport, { isLinkCapture: isLink })));
});

// Options page nudge (storage.onChanged covers persistence; this wakes a sleeping background).
// @types/webextension-polyfill 0.12 types the message as unknown — narrow before use.
browser.runtime.onMessage.addListener((raw: unknown) => {
  if (typeof raw !== "object" || raw === null) return;
  const msg = raw as { source?: string; type?: string; features?: ConnectorSettings["features"] };
  if (msg.source === SOURCE && msg.type === "settings-changed" && msg.features) {
    buildMenus(msg.features);
  }
});
