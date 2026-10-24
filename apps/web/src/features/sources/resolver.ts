/**
 * The add-source resolver client — the web side of the server's metadata
 * resolver (apps/server/src/resolve-source.ts): GET /api/resolve?doi=|isbn=|
 * arxiv= and POST /api/resolve/pdf (multipart upload or ?url=). Pure fetch
 * plumbing, no React — the AddSourceDialog and the paste-URL picker row
 * compose it.
 *
 * The unified record answers verbatim: {classKey, title, authors[], editors[],
 * fields{}, doi?, isbn?, url?, year?, publisher?} — the ?url= PDF mode adds
 * pdf:{url} (the attach intent: the direct full-text link; the bytes never
 * reach the client, so the create flow links the URL, never a CAS upload).
 *
 * Input classification (one input accepts everything): an arXiv id/URL, a
 * DOI (bare or a doi.org URL), an ISBN (10/13, hyphens tolerated), or a
 * plain http(s) URL (treated as a PDF link — the server's ?url= flow) — a
 * File never classifies; the dialog routes file inputs to the multipart
 * path directly. Unrecognized text answers null (the caller shows the
 * honest empty/error state).
 *
 * The pinned error taxonomy (errors.ts) maps onto ResolverRequestError.code:
 * resolver_disabled (403 — the sources settings turned the egress off),
 * no_identifier_found (422 — the PDF carried no DOI), not_found (404 —
 * the providers never heard of the identifier), resolver_unavailable (502 —
 * a provider failed/timed out), validation_failed (422), plus the
 * client-side network/invalid_response codes.
 */

/** The unified resolver record (the server's SourceMetadataRecord, verbatim). */
export interface ResolvedSourceRecord {
  /** The system class key (SYSTEM_CLASS_UUIDS[classKey] is the class id). */
  classKey: string;
  title: string;
  /** "Family, Given" strings. */
  authors: string[];
  /** "Family, Given" strings; [] when the provider names no editors. */
  editors: string[];
  /** Pool-key → value, the class's OWN venue bindings only. */
  fields: Record<string, string>;
  doi?: string;
  isbn?: string;
  url?: string;
  year?: number;
  publisher?: string;
  /** The ?url= PDF mode's attach intent (the direct full-text URL). */
  pdf?: { url?: string };
}

export type ResolverErrorCode =
  | "resolver_disabled"
  | "no_identifier_found"
  | "not_found"
  | "resolver_unavailable"
  | "validation_failed"
  | "network"
  | "invalid_response";

/** The resolver request failure: the pinned taxonomy code + the server's message. */
export class ResolverRequestError extends Error {
  constructor(
    readonly code: ResolverErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ResolverRequestError";
  }
}

/** One classified add-source input. */
export type ClassifiedSourceInput =
  | { kind: "doi"; value: string }
  | { kind: "isbn"; value: string }
  | { kind: "arxiv"; value: string }
  | { kind: "url"; url: string };

const ARXIV_INPUT = /(?:^arxiv:|arxiv\.org\/(?:abs|pdf)\/)([a-z.-]*\/?\d{4}[\d.]*|\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?$/i;
const DOI_INPUT = /^(?:https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/\S+)$/i;
const URL_INPUT = /^https?:\/\/\S+$/i;

/**
 * Classify one pasted string: arXiv id/URL → arxiv; a DOI (bare or a
 * doi.org URL) → doi; an ISBN (10/13 digits + X, separators tolerated) →
 * isbn; a plain http(s) URL → url (the PDF-link flow). Anything else null.
 */
export function classifySourceInput(raw: string): ClassifiedSourceInput | null {
  const text = raw.trim();
  if (text === "") return null;
  const arxiv = ARXIV_INPUT.exec(text);
  if (arxiv !== null) return { kind: "arxiv", value: arxiv[1]! };
  const doi = DOI_INPUT.exec(text);
  if (doi !== null) return { kind: "doi", value: doi[1]!.replace(/[.,;)\]}]+$/u, "") };
  const isbnish = text.replace(/[- ]/g, "");
  if (/^(\d{9}[\dX]|\d{13})$/i.test(isbnish)) return { kind: "isbn", value: text };
  if (URL_INPUT.test(text)) return { kind: "url", url: text };
  return null;
}

/** The credential rides the API-key header slot (the session token occupies it). */
function resolverHeaders(credential: string): Record<string, string> {
  return { "X-API-Key": credential };
}

function normalizeErrorCode(code: unknown, status: number): ResolverErrorCode {
  switch (code) {
    case "resolver_disabled":
    case "no_identifier_found":
    case "not_found":
    case "resolver_unavailable":
    case "validation_failed":
      return code;
    default:
      return status >= 500 ? "resolver_unavailable" : "validation_failed";
  }
}

function normalizeRecord(body: unknown): ResolvedSourceRecord {
  const record = body as Partial<ResolvedSourceRecord> | null;
  if (
    record === null ||
    typeof record !== "object" ||
    typeof record.classKey !== "string" ||
    typeof record.title !== "string" ||
    !Array.isArray(record.authors) ||
    !Array.isArray(record.editors) ||
    typeof record.fields !== "object" ||
    record.fields === null
  ) {
    throw new ResolverRequestError("invalid_response", "the resolver answered an unexpected shape");
  }
  const strings = (values: unknown[]): string[] =>
    values.filter((value): value is string => typeof value === "string");
  return {
    classKey: record.classKey,
    title: record.title,
    authors: strings(record.authors),
    editors: strings(record.editors),
    fields: Object.fromEntries(
      Object.entries(record.fields).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
    ...(typeof record.doi === "string" ? { doi: record.doi } : {}),
    ...(typeof record.isbn === "string" ? { isbn: record.isbn } : {}),
    ...(typeof record.url === "string" ? { url: record.url } : {}),
    ...(typeof record.year === "number" && Number.isFinite(record.year) ? { year: record.year } : {}),
    ...(typeof record.publisher === "string" ? { publisher: record.publisher } : {}),
    ...(record.pdf !== undefined && record.pdf !== null && typeof record.pdf === "object"
      ? {
          pdf: {
            ...(typeof (record.pdf as { url?: unknown }).url === "string"
              ? { url: (record.pdf as { url: string }).url }
              : {}),
          },
        }
      : {}),
  };
}

async function requestRecord(
  serverUrl: string,
  credential: string,
  path: string,
  init: RequestInit = {},
): Promise<ResolvedSourceRecord> {
  let response: Response;
  try {
    response = await fetch(`${serverUrl.replace(/\/$/, "")}/api${path}`, {
      ...init,
      headers: { ...resolverHeaders(credential), ...(init.headers ?? {}) },
    });
  } catch (error) {
    throw new ResolverRequestError(
      "network",
      `could not reach the server (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!response.ok) {
    let code: unknown = undefined;
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
      code = body.error?.code;
      if (typeof body.error?.message === "string") message = body.error.message;
    } catch {
      // a non-JSON error body — the status message above is the honest text
    }
    throw new ResolverRequestError(normalizeErrorCode(code, response.status), message);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ResolverRequestError("invalid_response", "the resolver answered a non-JSON body");
  }
  return normalizeRecord(body);
}

/**
 * Resolve one text input end to end: doi/isbn/arxiv ride GET /api/resolve;
 * a plain URL rides POST /api/resolve/pdf?url= (the server's PDF flow — the
 * DOI printed in the fetched bytes resolves the metadata). Unrecognized
 * text fails loud (null classification → a plain Error the dialog phrases).
 */
export async function resolveSourceInput(
  serverUrl: string,
  credential: string,
  raw: string,
): Promise<ResolvedSourceRecord> {
  const classified = classifySourceInput(raw);
  if (classified === null) {
    throw new ResolverRequestError(
      "validation_failed",
      "not a DOI, ISBN, arXiv id, or URL — paste one of those (or pick a PDF file)",
    );
  }
  switch (classified.kind) {
    case "doi":
      return requestRecord(
        serverUrl,
        credential,
        `/resolve?doi=${encodeURIComponent(classified.value)}`,
      );
    case "isbn":
      return requestRecord(
        serverUrl,
        credential,
        `/resolve?isbn=${encodeURIComponent(classified.value)}`,
      );
    case "arxiv":
      return requestRecord(
        serverUrl,
        credential,
        `/resolve?arxiv=${encodeURIComponent(classified.value)}`,
      );
    case "url":
      return requestRecord(serverUrl, credential, `/resolve/pdf?url=${encodeURIComponent(classified.url)}`, {
        method: "POST",
      });
  }
}

/**
 * Resolve an uploaded PDF (multipart, the CAS intake idiom): the server
 * scans the bytes for a DOI and resolves the metadata. No DOI → 422
 * no_identifier_found. The returned record is the attach intent's other
 * half — the caller uploads THESE bytes to CAS and links them on the
 * created source.
 */
export async function resolvePdfFile(
  serverUrl: string,
  credential: string,
  file: Blob,
  filename: string,
): Promise<ResolvedSourceRecord> {
  const form = new FormData();
  form.append("file", file, filename);
  return requestRecord(serverUrl, credential, "/resolve/pdf", {
    method: "POST",
    body: form,
  });
}
