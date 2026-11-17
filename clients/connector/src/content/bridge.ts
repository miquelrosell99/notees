import browser from "webextension-polyfill";
import { SOURCE } from "../shared/source";
import {
  PageCaptureResponse,
  RelayToPage,
  pageRequestFromRelay,
  pageResponseToRelay,
} from "../shared/messages";

declare global {
  interface Window {
    __noteesConnectorBridgeInstalled?: boolean;
  }
}

function install(): void {
  // background → page
  browser.runtime.onMessage.addListener((msg: unknown) => {
    // polyfill types the listener param as unknown; narrow via the same guard
    const relay = msg as RelayToPage;
    if (relay?.source !== SOURCE || relay.type !== "relay-to-page") return;
    const request = pageRequestFromRelay(relay);
    // targetOrigin is this page's own origin: the script only runs in serverUrl tabs
    window.postMessage(request, window.location.origin);
  });

  // page → background
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data as PageCaptureResponse;
    if (data?.source !== SOURCE || data.type !== "notees-capture-response") return;
    void browser.runtime.sendMessage(pageResponseToRelay(data));
  });
}

// Idempotent: ensureBridge may inject into the same tab repeatedly.
if (!window.__noteesConnectorBridgeInstalled) {
  window.__noteesConnectorBridgeInstalled = true;
  install();
}
