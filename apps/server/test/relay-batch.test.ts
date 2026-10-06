import { afterEach, describe, expect, it } from "vitest";

import { closeTestServer, ingest, makeTestServer, pagePayload, testEnvelope, type TestServer } from "./helpers";

let server: TestServer | null = null;
afterEach(async () => {
  if (server !== null) {
    await closeTestServer(server);
    server = null;
  }
});

describe("POST /batch", () => {
  it("saves a valid envelope and reports savedCount/savedIds", async () => {
    server = await makeTestServer();
    const env = testEnvelope({ opType: "object.create", payload: pagePayload("First") });
    const res = await ingest(server, [env]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ savedCount: 1, savedIds: [env.id] });
  });

  it("duplicate ids are silently ignored (idempotent retry)", async () => {
    server = await makeTestServer();
    const env = testEnvelope({ opType: "object.create", payload: pagePayload("Twice") });
    const first = await ingest(server, [env]);
    expect(first.json().savedCount).toBe(1);
    const retry = await ingest(server, [env]);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ savedCount: 0, savedIds: [] });

    const catchUp = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/catch-up",
      headers: { "content-type": "application/json", ...server.authHeaders },
      payload: { workspaceId: server.workspaceId, afterSeq: 0, limit: 100 },
    });
    const body = catchUp.json();
    expect(body.envelopes).toHaveLength(1);
    expect(body.envelopes[0].id).toBe(env.id);
    // catch-up envelopes never carry a server seq inside the envelope.
    expect(body.envelopes[0].seq).toBeUndefined();
  });

  it("mixed batches across workspaces ingest independently", async () => {
    server = await makeTestServer();
    const otherWorkspace = "22222222-2222-4333-8444-555555555555";
    const a = testEnvelope({ opType: "object.create", payload: pagePayload("A") });
    const b = testEnvelope({ workspaceId: otherWorkspace, opType: "object.create", payload: pagePayload("B") });
    const res = await ingest(server, [a, b]);
    expect(res.statusCode).toBe(200);
    expect(res.json().savedCount).toBe(2);
    const statsA = await server.app.inject({
      method: "GET",
      url: `/api/relay/v2/stats?workspaceId=${server.workspaceId}`,
      headers: server.authHeaders,
    });
    expect(statsA.json().envelopeCount).toBe(1);
  });

  it("per-envelope rate accounting: exceeding the workspace bucket answers 429", async () => {
    server = await makeTestServer({ relayBatchPerMinute: 3 });
    const envelopes = Array.from({ length: 4 }, () =>
      testEnvelope({ opType: "object.create", payload: pagePayload("r") }),
    );
    const res = await ingest(server, envelopes);
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("rate_limited");
  });
});

describe("ingest validation (WIRE error shapes)", () => {
  it("requires authentication", async () => {
    server = await makeTestServer();
    const env = testEnvelope({ opType: "object.create", payload: pagePayload("x") });
    const res = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/batch",
      headers: { "content-type": "application/json" },
      payload: { envelopes: [env] },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatchObject({ code: "unauthenticated", status: 401 });
  });

  it("rejects a wrong key with the unauthenticated envelope", async () => {
    server = await makeTestServer();
    const env = testEnvelope({ opType: "object.create", payload: pagePayload("x") });
    const res = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/batch",
      headers: { "content-type": "application/json", "x-api-key": `nk_${"b".repeat(32)}` },
      payload: { envelopes: [env] },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthenticated");
  });

  it("rejects envelopes without protocolVersion (422 validation_failed)", async () => {
    server = await makeTestServer();
    const env = testEnvelope({ opType: "object.create", payload: pagePayload("x") });
    const broken = { ...env, protocolVersion: undefined } as Record<string, unknown>;
    delete broken.protocolVersion;
    const res = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/batch",
      headers: { "content-type": "application/json", ...server.authHeaders },
      payload: { envelopes: [broken] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: "validation_failed", status: 422 });
  });

  it("rejects unknown opTypes", async () => {
    server = await makeTestServer();
    const env = testEnvelope({ opType: "object.explode", payload: { objectId: crypto.randomUUID() } });
    const res = await ingest(server, [env]);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("validation_failed");
  });

  it("rejects payload schema violations with the stable code", async () => {
    server = await makeTestServer();
    const env = testEnvelope({
      opType: "object.create",
      payload: { objectId: crypto.randomUUID(), presentAsMain: "planet" },
    });
    const res = await ingest(server, [env]);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("validation_failed");
  });

  it("rejects the retired nodeType payload key outright (envelope v3, no backward compatibility)", async () => {
    server = await makeTestServer();
    const env = testEnvelope({
      opType: "object.create",
      payload: { objectId: crypto.randomUUID(), nodeType: "page" },
    });
    const res = await ingest(server, [env]);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("validation_failed");
  });

  it("rejects batches over 1000 envelopes", async () => {
    server = await makeTestServer();
    const envelopes = Array.from({ length: 1001 }, () =>
      testEnvelope({ opType: "object.create", payload: pagePayload("bulk") }),
    );
    const res = await ingest(server, envelopes);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("validation_failed");
  });

  it("lets the encrypted slot pass through unvalidated", async () => {
    server = await makeTestServer();
    const env = testEnvelope({ opType: "object.create", payload: { $e: { iv: "x", ct: "y" } } });
    const res = await ingest(server, [env]);
    expect(res.statusCode).toBe(200);
    expect(res.json().savedCount).toBe(1);
  });
});
