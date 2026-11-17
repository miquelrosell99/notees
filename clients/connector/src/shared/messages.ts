import { SOURCE } from "./source";

/** Payload the Notees page receives. Normative — must match the spec verbatim. */
export interface PageCapturePayload {
  url: string;
  title: string;
  mode: "source" | "readlater";
  note?: string;
}

export interface PageCaptureRequest {
  source: typeof SOURCE;
  type: "notees-capture-request";
  requestId: string;
  payload: PageCapturePayload;
}

export interface PageCaptureOk {
  source: typeof SOURCE;
  type: "notees-capture-response";
  requestId: string;
  ok: true;
  objectId: string;
}

export interface PageCaptureError {
  code: "not_authenticated" | "feature_disabled" | "failed";
  message: string;
}

export interface PageCaptureErr {
  source: typeof SOURCE;
  type: "notees-capture-response";
  requestId: string;
  ok: false;
  error: PageCaptureError;
}

export type PageCaptureResponse = PageCaptureOk | PageCaptureErr;

/** Internal: background → content script (bridged to page as PageCaptureRequest). */
export interface RelayToPage {
  source: typeof SOURCE;
  type: "relay-to-page";
  requestId: string;
  payload: PageCapturePayload;
}

/** Internal: content script → background (bridged from PageCaptureResponse). */
export interface RelayFromPageOk {
  source: typeof SOURCE;
  type: "relay-from-page";
  requestId: string;
  ok: true;
  objectId: string;
}

export interface RelayFromPageErr {
  source: typeof SOURCE;
  type: "relay-from-page";
  requestId: string;
  ok: false;
  error: PageCaptureError;
}

export type RelayFromPage = RelayFromPageOk | RelayFromPageErr;

export function pageResponseToRelay(msg: PageCaptureResponse): RelayFromPage {
  return msg.ok
    ? { source: SOURCE, type: "relay-from-page", requestId: msg.requestId, ok: true, objectId: msg.objectId }
    : { source: SOURCE, type: "relay-from-page", requestId: msg.requestId, ok: false, error: msg.error };
}

export function pageRequestFromRelay(msg: RelayToPage): PageCaptureRequest {
  return { source: SOURCE, type: "notees-capture-request", requestId: msg.requestId, payload: msg.payload };
}
