export type CaptureMode = "source" | "readlater";

export interface CaptureIdentifiers {
  doi?: string;
  isbn?: string;
}

/** POST /api/capture/web-page body (REST path). Identifiers are REST-only. */
export interface CapturePayload {
  url: string;
  title: string;
  mode: CaptureMode;
  identifiers?: CaptureIdentifiers;
  note?: string;
}

export type CaptureFailureCode =
  | "not_authenticated"
  | "feature_disabled"
  | "e2ee_required"
  | "network_error"
  | "http_error"
  | "failed";

export interface CaptureFailure {
  code: CaptureFailureCode;
  message: string;
}

export type CaptureOutcome =
  | { ok: true; transport: "tab-relay" | "rest"; objectId: string; collectionId?: string }
  | { ok: false; error: CaptureFailure };
