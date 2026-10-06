/**
 * Operation envelope v3 — the wire format of the Notees protocol.
 *
 * Clean-break properties (the Revision-11 assessment):
 *  - camelCase everywhere, on the wire and in payloads;
 *  - `protocolVersion: 3` is mandatory (a missing version is rejected, and
 *    only 3 is accepted — Revision 11, 2026-10-02);
 *  - first-class `deviceId` and optional `client` provenance claims;
 *  - `payload` is a plaintext object OR the encryption slot `{"$e": {iv, ct}}`
 *    (reserved for E2EE; defined since envelope v2 so E2EE never breaks
 *    the protocol);
 *  - `seq` is deliberately absent: server-assigned ordering never travels inside
 *    the envelope (it rides on catch-up frames / WS ops frames instead).
 *
 * v3 (Revision 11): the node model moves from `node_type ∈ {page, block, class}`
 * to two booleans (`is_class`, `present_as_main`); the retired `nodeType`
 * payload key is rejected outright (no wire compat — stored v2-era logs are
 * rewritten in place by the one-time migration script, planned).
 */

import { z } from "zod";
import { uuidv7 } from "uuidv7";
import { hlcSchema } from "./hlc.js";

export const PROTOCOL_VERSION = 3;

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
