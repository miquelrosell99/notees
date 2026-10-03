/**
 * Error envelope (WIRE.md §3): every endpoint failure answers
 * {"error": {code, message, status}} with stable machine codes.
 *
 * AC2 (§34.33): the code list below IS the pinned taxonomy. Every AppError a
 * route throws must use one of these codes, the OpenAPI document
 * (`src/openapi.ts`) exposes the same table under `x-error-codes`, and
 * test/error-taxonomy.test.ts fails on any drift between the three
 * (union ↔ taxonomy ↔ routes actually throwing it).
 */

export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "scope_denied"
  | "validation_failed"
  | "not_found"
  | "rate_limited"
  | "conflict"
  | "already_provisioned"
  | "invalid_credentials"
  | "account_locked"
  | "idempotency_replay"
  | "internal";

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export interface ErrorBody {
  error: { code: string; message: string; status: number };
}

export function errorBody(status: number, code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message, status } };
}

/**
 * The pinned taxonomy (§34.33 AC2): code → HTTP status → one-line meaning.
 * `status` is the canonical status (what the OpenAPI document and the error
 * envelope pin); `aliases` lists additional statuses the code legitimately
 * answers with today (e.g. the permanent-delete confirm guard answers 400
 * rather than 422 — pre-existing behavior kept additive). `internal` is the
 * 500 fallback of the global error handler; every other code is thrown
 * explicitly by route code. `scope_denied` (AG3) is the 403 a scoped API key
 * gets when a route needs a scope the key does not carry;
 * `idempotency_replay` (AG5) is the 409 for reusing an Idempotency-Key with a
 * different request than the original.
 */
export const ERROR_TAXONOMY: Readonly<
  Record<ErrorCode, { status: number; aliases?: readonly number[]; description: string }>
> = {
  unauthenticated: { status: 401, description: "missing, unknown, or expired credentials" },
  forbidden: { status: 403, description: "authenticated but not allowed (membership, role, self-revocation rules)" },
  scope_denied: { status: 403, description: "a scoped API key called a route outside its scope set (§34.33 AG3)" },
  validation_failed: {
    status: 422,
    aliases: [400, 416],
    description: "body/query/payload failed schema validation (fail loud, never half-applied)",
  },
  not_found: { status: 404, description: "the addressed object/class/asset/workspace/snapshot does not exist" },
  rate_limited: { status: 429, description: "a fixed-window limiter refused the call (global IP, relay batch, login)" },
  conflict: { status: 409, description: "write rejected: id already exists, stale base revision, or conflicting state" },
  already_provisioned: { status: 409, description: "POST /setup after the first account exists" },
  invalid_credentials: { status: 401, description: "login rejected (unknown email or wrong password, indistinguishable)" },
  account_locked: { status: 429, description: "per-account login lockout after 5 failures in 15 minutes" },
  idempotency_replay: { status: 409, description: "an Idempotency-Key was replayed with a different request than the original (§34.33 AG5)" },
  internal: { status: 500, description: "unclassified server failure (the only code not thrown by route code)" },
};

/** Taxonomy codes a route can throw explicitly (`internal` is the handler fallback). */
export const THROWN_ERROR_CODES: readonly ErrorCode[] = (
  Object.keys(ERROR_TAXONOMY) as ErrorCode[]
).filter((code) => code !== "internal");
