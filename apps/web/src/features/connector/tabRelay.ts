/**
 * The page side of the Notees Connector's tab relay (design spec 2026-11-08,
 * the citation & capture integrations design). The extension's injected
 * bridge postMessages a `notees-capture-request` into this page; the page
 * stamps the capture through its own sync engine (E2EE-transparent — the
 * page holds the master key) and answers `notees-capture-response` on the
 * SAME window. Wire rules: respond only to the workspace's configured
 * server origin with a window source (silence for everything else — except
 * the logged-out case, which answers not_authenticated so the extension
 * can tell "tab says no" from "no tab").
 */

export const CONNECTOR_SOURCE = "notees-connector";

export interface CaptureRequestMessage {
  source: "notees-connector";
  type: "notees-capture-request";
  requestId: string;
  payload: {
    url: string;
    title: string;
    mode: "source" | "readlater";
    note?: string | undefined;
  };
}

export type CaptureResponseMessage = {
  source: "notees-connector";
  type: "notees-capture-response";
  requestId: string;
} & (
  | { ok: true; objectId: string }
  | {
      ok: false;
      error: {
        code: "not_authenticated" | "feature_disabled" | "failed";
        message: string;
      };
    }
);

export type CaptureFailureCode = "not_authenticated" | "feature_disabled" | "failed";

export type CaptureResult =
  | { ok: true; objectId: string }
  | { ok: false; code: CaptureFailureCode; message: string };

/** The strict shape guard — anything else never reaches the host. */
export function isCaptureRequest(data: unknown): data is CaptureRequestMessage {
  if (typeof data !== "object" || data === null) return false;
  const m = data as Record<string, unknown>;
  if (m.source !== CONNECTOR_SOURCE) return false;
  if (m.type !== "notees-capture-request") return false;
  if (typeof m.requestId !== "string" || m.requestId === "") return false;
  const p = m.payload;
  if (typeof p !== "object" || p === null) return false;
  const payload = p as Record<string, unknown>;
  if (typeof payload.url !== "string" || payload.url.trim() === "") return false;
  if (typeof payload.title !== "string") return false;
  if (payload.mode !== "source" && payload.mode !== "readlater") return false;
  if (payload.note !== undefined && typeof payload.note !== "string") return false;
  return true;
}

/** Exact match against the workspace's configured server origin. */
export function isAllowedOrigin(origin: string, serverOrigin: string): boolean {
  return origin === serverOrigin;
}

export function buildResponse(request: CaptureRequestMessage, result: CaptureResult): CaptureResponseMessage {
  const base = {
    source: CONNECTOR_SOURCE,
    type: "notees-capture-response",
    requestId: request.requestId,
  } as const;
  return result.ok
    ? { ...base, ok: true, objectId: result.objectId }
    : { ...base, ok: false, error: { code: result.code, message: result.message } };
}

export interface TabRelayHost {
  /** The configured server origin; null when no authed session is open. */
  serverOrigin(): string | null;
  /** Stamp the capture; the App hook owns the gating and the graph write. */
  handleCapture(payload: CaptureRequestMessage["payload"]): Promise<CaptureResult>;
}

/** Install the listener; returns the uninstall function. */
export function installTabRelay(win: Window, host: TabRelayHost): () => void {
  const onMessage = (event: MessageEvent) => {
    const serverOrigin = host.serverOrigin();
    if (serverOrigin === null) {
      // Logged out (Review Focus 1): a well-formed request still earns an
      // honest not_authenticated — on whatever origin it arrived from.
      if (isCaptureRequest(event.data) && event.source !== null) {
        const response = buildResponse(event.data, {
          ok: false,
          code: "not_authenticated",
          message: "No Notees workspace is open in this tab.",
        });
        (event.source as Window).postMessage(response, event.origin);
      }
      return;
    }
    if (event.source === null || typeof (event.source as Window).postMessage !== "function") return;
    if (!isAllowedOrigin(event.origin, serverOrigin)) return; // foreign origin: silence
    if (!isCaptureRequest(event.data)) return;
    const request = event.data;
    const target = event.source as Window;
    const targetOrigin = event.origin;
    void host.handleCapture(request.payload).then(
      (result) => target.postMessage(buildResponse(request, result), targetOrigin),
      (error: unknown) =>
        target.postMessage(
          buildResponse(request, {
            ok: false,
            code: "failed",
            message: error instanceof Error ? error.message : "Capture failed.",
          }),
          targetOrigin,
        ),
    );
  };
  win.addEventListener("message", onMessage);
  return () => win.removeEventListener("message", onMessage);
}
