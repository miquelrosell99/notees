import browser from "webextension-polyfill";
import { CaptureFailure } from "../shared/capture-types";

// PNG, not SVG: several OS notification servers refuse to render SVG icons.
const ICON_URL = browser.runtime.getURL("icons/icon-96.png");

export async function notify(title: string, message: string): Promise<void> {
  await browser.notifications.create({ type: "basic", iconUrl: ICON_URL, title, message });
}

const COPY: Record<CaptureFailure["code"], [string, string]> = {
  e2ee_required: [
    "Open Notees to capture",
    "This workspace is end-to-end encrypted, so the extension cannot write to it directly. Open your Notees tab and capture again — the tab relay keeps everything encrypted.",
  ],
  not_authenticated: [
    "Notees is not signed in",
    "Sign in to the open Notees tab, or add an API key in the connector settings, then try again.",
  ],
  feature_disabled: [
    "Feature not enabled",
    "Enable bibliography capture or read-it-later in your Notees workspace settings.",
  ],
  network_error: [
    "Notees server unreachable",
    "Check the server URL and your network connection in the connector settings.",
  ],
  http_error: ["Notees server error", "The server returned an unexpected error."],
  failed: ["Notees capture failed", "Something went wrong while capturing this page."],
};

export async function notifyFailure(error: CaptureFailure): Promise<void> {
  const [title, message] = COPY[error.code] ?? COPY.failed;
  await notify(title, `${message}${error.message ? ` (${error.message})` : ""}`);
}
