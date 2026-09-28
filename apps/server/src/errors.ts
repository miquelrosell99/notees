/**
 * Error envelope (WIRE.md §3): every endpoint failure answers
 * {"error": {code, message, status}} with stable machine codes.
 */

export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "validation_failed"
  | "not_found"
  | "rate_limited"
  | "conflict"
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
