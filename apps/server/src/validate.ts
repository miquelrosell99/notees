/**
 * Relay-ingest validation (WIRE.md §1): full envelope schema check plus the
 * M1 op-registry payload shapes. The M3 E2EE slot ({"$e": …}) passes through
 * unvalidated by design — payloads are opaque to the relay except that slot.
 */

import {
  envelopeSchema,
  isEncryptedPayload,
  payloadSchemaFor,
  type Envelope,
} from "@notees/protocol";

export const MAX_BATCH_ENVELOPES = 1000;
export const MAX_PAYLOAD_BYTES = 1_000_000;

export class RelayValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Validate one envelope for relay ingest (shape + plaintext payload). */
export function validateRelayEnvelope(input: unknown): Envelope {
  const parsed = envelopeSchema.safeParse(input);
  if (!parsed.success) {
    throw new RelayValidationError(`invalid envelope: ${parsed.error.issues[0]?.message ?? parsed.error.message}`);
  }
  const env = parsed.data;
  if (!isEncryptedPayload(env.payload)) {
    const schema = payloadSchemaFor(env.opType);
    if (schema === undefined) {
      throw new RelayValidationError(`unknown opType: ${env.opType}`);
    }
    const payload = schema.safeParse(env.payload);
    if (!payload.success) {
      throw new RelayValidationError(
        `invalid ${env.opType} payload: ${payload.error.issues[0]?.message ?? payload.error.message}`,
      );
    }
    if (JSON.stringify(env.payload).length > MAX_PAYLOAD_BYTES) {
      throw new RelayValidationError(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
    }
    return { ...env, payload: payload.data as Envelope["payload"] };
  }
  return env;
}

export function validateRelayBatch(input: unknown): Envelope[] {
  if (typeof input !== "object" || input === null || !Array.isArray((input as { envelopes?: unknown }).envelopes)) {
    throw new RelayValidationError('request body must be {"envelopes": [...]}');
  }
  const raw = (input as { envelopes: unknown[] }).envelopes;
  if (raw.length === 0) {
    throw new RelayValidationError("envelopes must not be empty");
  }
  if (raw.length > MAX_BATCH_ENVELOPES) {
    throw new RelayValidationError(`batch exceeds ${MAX_BATCH_ENVELOPES} envelopes`);
  }
  return raw.map((item) => validateRelayEnvelope(item));
}
