import browser from "webextension-polyfill";
import { SOURCE } from "../shared/source";
import { CaptureOutcome, CapturePayload } from "../shared/capture-types";
import { RelayFromPage, RelayToPage } from "../shared/messages";

export const RELAY_TIMEOUT_MS = 15000;

export async function captureViaRelay(tabId: number, payload: CapturePayload): Promise<CaptureOutcome> {
  const requestId = crypto.randomUUID();
  return new Promise<CaptureOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: CaptureOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      browser.runtime.onMessage.removeListener(listener);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: { code: "failed", message: "The Notees tab did not answer" } });
    }, RELAY_TIMEOUT_MS);

    // @types/webextension-polyfill 0.12 types the message as unknown — narrow before use.
    const listener = (raw: unknown) => {
      if (typeof raw !== "object" || raw === null) return;
      const msg = raw as RelayFromPage;
      if (msg.source !== SOURCE || msg.type !== "relay-from-page" || msg.requestId !== requestId) return;
      finish(msg.ok
        ? { ok: true, transport: "tab-relay", objectId: msg.objectId }
        : { ok: false, error: msg.error });
    };
    browser.runtime.onMessage.addListener(listener);

    // Identifiers are REST-only; the page protocol has no field for them.
    const { identifiers, ...pagePayload } = payload;
    const message: RelayToPage = { source: SOURCE, type: "relay-to-page", requestId, payload: pagePayload };
    browser.tabs.sendMessage(tabId, message).catch(() => {
      finish({ ok: false, error: { code: "failed", message: "Could not reach the Notees tab" } });
    });
  });
}
