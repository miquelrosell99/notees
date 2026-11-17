import type { CaptureOutcome, CapturePayload } from "../shared/capture-types";
import type { ConnectorSettings } from "../shared/settings";
import type { captureViaRelay } from "./relay";
import type { captureViaRest } from "./rest-client";
import type { ensureBridge, findNoteesTab } from "./tabs";

export type Transport = "tab-relay" | "rest";

/**
 * The four transport pieces, injected so the background wiring and tests
 * compose freely — this module is pure orchestration and imports nothing
 * at runtime.
 */
export interface TransportDeps {
  findNoteesTab: typeof findNoteesTab;
  ensureBridge: typeof ensureBridge;
  captureViaRelay: typeof captureViaRelay;
  captureViaRest: typeof captureViaRest;
}

/**
 * Per-capture transport selection:
 *  1. Notees tab open (origin === serverUrl) → tab relay (zero credentials, E2EE-safe).
 *  2. Else direct REST.
 */
export function createTransport(deps: TransportDeps) {
  async function selectTransport(settings: ConnectorSettings): Promise<Transport> {
    if (settings.serverUrl && (await deps.findNoteesTab(settings.serverUrl))) return "tab-relay";
    return "rest";
  }

  async function captureWithTransport(
    settings: ConnectorSettings,
    payload: CapturePayload,
  ): Promise<CaptureOutcome> {
    const tab = settings.serverUrl ? await deps.findNoteesTab(settings.serverUrl) : null;
    if (tab?.id != null) {
      try {
        await deps.ensureBridge(tab.id);
        const outcome = await deps.captureViaRelay(tab.id, payload);
        if (outcome.ok) return outcome;
        // not_authenticated / feature_disabled are definitive page answers —
        // FINAL, no REST fallback after one of those. (e2ee_required is
        // REST-only by construction: PageCaptureError's union can't carry it.)
        // Only a generic "failed" (timeout, tab unreachable) falls through to REST.
        if (outcome.error.code !== "failed") return outcome;
      } catch {
        // Bridge injection blew up (e.g. tab closed mid-capture) — the tab
        // path is unavailable, not a final failure: fall through to REST.
      }
    }
    if (!settings.apiKey) {
      return { ok: false, error: { code: "not_authenticated", message: "Open Notees or add an API key in the connector settings" } };
    }
    return deps.captureViaRest(settings, payload);
  }

  return { selectTransport, captureWithTransport };
}
