/**
 * Transport-level error: the WIRE.md error envelope
 * `{"error": {"code", "message", "status"}}` surfaced as a typed Error.
 */

export class TransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TransportError";
  }
}
