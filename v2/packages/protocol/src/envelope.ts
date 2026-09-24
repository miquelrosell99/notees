/**
 * Operation envelope v2 — the wire format of the Notees protocol.
 *
 * Clean-break properties vs v1 (assessment §34.4):
 *  - camelCase everywhere, on the wire and in payloads;
 *  - `protocolVersion: 2` is mandatory (a missing version is rejected);
 *  - first-class `deviceId` and optional `client` provenance claims;
 *  - `payload` is a plaintext object OR the encryption slot `{"$e": {iv, ct}}`
 *    (reserved for M3 E2EE; v2 defines the slot so E2EE never breaks the protocol);
 *  - `seq` is deliberately absent: server-assigned ordering never travels inside
 *    the envelope (it rides on catch-up frames / WS ops frames instead).
 */

import { z } from "zod";
import { uuidv7 } from "uuidv7";
import { hlcSchema } from "./hlc.js";

export const PROTOCOL_VERSION = 2;

/** Provenance claim: which client produced an operation. */
export const clientClaimSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*(:[a-z0-9-]+)?$/, "client must look like 'web', 'cli', or 'agent:<id>'");

export const encryptedPayloadSchema = z
  .object({
    $e: z.object({
      iv: z.string(),
      ct: z.string(),
    }),
  })
  .strict();

export function isEncryptedPayload(payload: unknown): payload is { $e: { iv: string; ct: string } } {
  return encryptedPayloadSchema.safeParse(payload).success;
}

export const envelopeSchema = z
  .object({
    id: z.string().uuid(),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    workspaceId: z.string().uuid(),
    actorId: z.string().uuid(),
    deviceId: z.string().min(1).max(128),
    client: clientClaimSchema.optional(),
    hlc: hlcSchema,
    affectedNodeIds: z.array(z.string().uuid()).max(10_000).default([]),
    opType: z.string().min(1),
    timestamp: z.string().datetime(),
    payload: z.union([z.record(z.unknown()), encryptedPayloadSchema]),
  })
  .strict();

export type Envelope = z.infer<typeof envelopeSchema>;

export interface NewEnvelopeInput {
  workspaceId: string;
  actorId: string;
  deviceId: string;
  client?: string;
  hlc: { physical: number; logical: number };
  affectedNodeIds?: string[];
  opType: string;
  payload: Record<string, unknown> | { $e: { iv: string; ct: string } };
  timestamp?: string;
}

export function newEnvelope(input: NewEnvelopeInput): Envelope {
  return envelopeSchema.parse({
    id: uuidv7(),
    protocolVersion: PROTOCOL_VERSION,
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    deviceId: input.deviceId,
    ...(input.client !== undefined ? { client: input.client } : {}),
    hlc: input.hlc,
    affectedNodeIds: input.affectedNodeIds ?? [],
    opType: input.opType,
    timestamp: input.timestamp ?? new Date().toISOString(),
    payload: input.payload,
  });
}
