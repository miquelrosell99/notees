/**
 * Server-side envelope stamping. The object/assets API writes are envelopes
 * like any other (one write path): the server stamps id (uuidv7), the
 * protocol version (envelope v3 — @notees/protocol), HLC (device clock
 * seeded from the relay log max), timestamp, and the actor derived from the
 * authenticated API key.
 */

import { Clock, newEnvelope, type Envelope } from "@notees/protocol";

export const SERVER_DEVICE_ID = "notees-server";

export interface StampInput {
  workspaceId: string;
  opType: string;
  payload: Record<string, unknown>;
  affectedNodeIds?: string[];
  client?: string;
}

export class EnvelopeFactory {
  constructor(
    private readonly clock: Clock,
    private readonly actorId: string,
  ) {}

  make(input: StampInput): Envelope {
    return newEnvelope({
      workspaceId: input.workspaceId,
      actorId: this.actorId,
      deviceId: SERVER_DEVICE_ID,
      ...(input.client !== undefined ? { client: input.client } : {}),
      hlc: this.clock.now(),
      affectedNodeIds: input.affectedNodeIds ?? [],
      opType: input.opType,
      payload: input.payload,
      timestamp: new Date().toISOString(),
    });
  }
}
