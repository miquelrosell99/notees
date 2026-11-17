import { CaptureOutcome, CapturePayload } from "../shared/capture-types";
import { ConnectorSettings } from "../shared/settings";

const CAPTURE_TIMEOUT_MS = 15000;

/**
 * Direct REST transport. The API key leaves the extension only inside this
 * function, only in the X-API-Key header, only to `${settings.serverUrl}/api/…`.
 */
export async function captureViaRest(
  settings: ConnectorSettings,
  payload: CapturePayload,
): Promise<CaptureOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);
  try {
    const body = { ...payload };
    // An identifiers object with neither doi nor isbn carries no information —
    // omit it rather than send an empty bag.
    if (
      body.identifiers !== undefined &&
      body.identifiers.doi === undefined &&
      body.identifiers.isbn === undefined
    ) {
      delete body.identifiers;
    }
    const res = await fetch(`${settings.serverUrl}/api/capture/web-page`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": settings.apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.status === 201) {
      const data = (await res.json()) as { objectId: string; collectionId?: string };
      return { ok: true, transport: "rest", objectId: data.objectId, collectionId: data.collectionId };
    }
    let code: "not_authenticated" | "feature_disabled" | "e2ee_required" | "http_error" = "http_error";
    let message = `Server answered ${res.status}`;
    try {
      // Lane A's error envelope (WIRE.md): {error: {code, message, status}}.
      const data = (await res.json()) as { error?: { code?: string; message?: string } };
      if (res.status === 401) code = "not_authenticated";
      else if (data.error?.code === "feature_disabled") code = "feature_disabled";
      else if (data.error?.code === "e2ee_required") code = "e2ee_required";
      if (data.error?.message) message = data.error.message;
    } catch {
      // non-JSON error body — keep the status-based message
    }
    return { ok: false, error: { code, message } };
  } catch {
    return { ok: false, error: { code: "network_error", message: "Could not reach the Notees server" } };
  } finally {
    clearTimeout(timer);
  }
}
