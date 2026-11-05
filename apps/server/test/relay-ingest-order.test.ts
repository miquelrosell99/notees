/**
 * Relay batch ingest — the poison decision lands BEFORE persistence.
 *
 * A payload-semantic rejection (an apply-time StoreError — e.g. a wrong-typed
 * propertySchema defaultValue, which the route-level payload schema
 * deliberately types z.unknown()) must 422 WITHOUT the envelope entering the
 * stored log. The old persists-then-applies order saved the batch first and
 * applied second, so a rejected envelope sat in the relay log forever: every
 * hydration, every self-heal sweep, and every fresh client's catch-up
 * re-hit the unappliable envelope and re-quarantined it.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  closeTestServer,
  ingest,
  makeTestServer,
  pagePayload,
  testEnvelope,
  type TestServer,
} from "./helpers";

let server: TestServer | null = null;
afterEach(async () => {
  if (server !== null) {
    await closeTestServer(server);
    server = null;
  }
});

async function catchUp() {
  const response = await server!.app.inject({
    method: "POST",
    url: "/api/relay/v2/catch-up",
    headers: { "content-type": "application/json", ...server!.authHeaders },
    payload: { workspaceId: server!.workspaceId, afterSeq: 0 },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    envelopes: Array<{ id: string; opType: string; payload: Record<string, unknown> }>;
  };
}

describe("relay batch ingest — apply before persist", () => {
  it("a payload-semantic rejection 422s and the poison envelope never enters the log", async () => {
    server = await makeTestServer();
    const poisonId = crypto.randomUUID();
    const poison = testEnvelope({
      opType: "propertySchema.create",
      payload: {
        propertySchemaId: poisonId,
        name: "Broken",
        type: "number",
        // Route validation types defaultValue z.unknown(); the STORE rejects
        // the wrong-typed default at apply time (PC2) — that is the gap.
        defaultValue: "not-a-number",
      },
    });
    const validId = crypto.randomUUID();
    const valid = testEnvelope({
      opType: "object.create",
      payload: pagePayload("Survivor", { objectId: validId }),
    });

    const rejected = await ingest(server, [valid, poison]);
    expect(rejected.statusCode).toBe(422);

    // The rejected batch is absent from the stored log — the batch applies
    // in one store transaction, so the valid envelope in it rolls back too —
    // and a fresh client's catch-up never re-hits the poison.
    const caught = await catchUp();
    expect(caught.envelopes.find((env) => env.payload.propertySchemaId === poisonId)).toBeUndefined();
    expect(caught.envelopes.find((env) => env.payload.objectId === validId)).toBeUndefined();

    // The pipeline is not wedged: the good envelope, re-sent on its own,
    // lands and reads back.
    const retry = await ingest(server, [valid]);
    expect(retry.statusCode).toBe(200);
    expect((retry.json() as { savedCount: number }).savedCount).toBe(1);
    const after = await catchUp();
    expect(after.envelopes.some((env) => env.payload.objectId === validId)).toBe(true);
  });

  it("a poison envelope alone is rejected without a seq ever being assigned", async () => {
    server = await makeTestServer();
    const poison = testEnvelope({
      opType: "propertySchema.create",
      payload: {
        propertySchemaId: crypto.randomUUID(),
        name: "Broken",
        type: "datetime",
        defaultValue: { nodeId: crypto.randomUUID() },
      },
    });
    const rejected = await ingest(server, [poison]);
    expect(rejected.statusCode).toBe(422);
    const caught = await catchUp();
    expect(caught.envelopes.some((env) => env.id === poison.id)).toBe(false);
    expect(caught.envelopes).toHaveLength(0);
  });

  it("sealed envelopes still ride the log unapplied", async () => {
    server = await makeTestServer();
    // The E2EE slot is opaque to the relay: no apply is attempted, so the
    // pre-persist apply gate must not (and cannot) reject it.
    const sealed = testEnvelope({
      opType: "object.create",
      payload: { $e: { iv: "aXY", ct: "Y2lwaGVydGV4dA" } },
    });
    const accepted = await ingest(server, [sealed]);
    expect(accepted.statusCode).toBe(200);
    const caught = await catchUp();
    expect(caught.envelopes.some((env) => env.id === sealed.id)).toBe(true);
  });
});
