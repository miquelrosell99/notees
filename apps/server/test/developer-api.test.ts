/**
 * §34.33 developer-API behavior tests: the agent-safety batch (AG5 meta /
 * operations feed / Idempotency-Key / baseRevision) and scoped API keys
 * (AG3) end to end over HTTP.
 */

import { afterEach, describe, expect, it } from "vitest";

import { IDEMPOTENCY_REPLAY_HEADER } from "../src/idempotency.js";
import { SERVER_VERSION } from "../src/index.js";

import {
  closeTestServer,
  ingest,
  makeTestServer,
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

const OBJECTS = "/api/objects";

describe("GET /api/meta", () => {
  it("describes the server without authentication", async () => {
    server = await makeTestServer();
    const response = await server.app.inject({ method: "GET", url: "/api/meta" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.name).toBe("notees-server");
    expect(body.version).toBe(SERVER_VERSION);
    expect(body.protocolVersion).toBe(3);
    expect(body.wsProtocolVersion).toBe(2);
    expect(body.defaultWorkspaceId).toBe(server.ctx.defaultWorkspace);
    expect(body.setupRequired).toBe(true);
  });
});

describe("GET /api/operations", () => {
  it("rejects unauthenticated reads", async () => {
    server = await makeTestServer();
    const response = await server.app.inject({ method: "GET", url: "/api/operations" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthenticated");
  });

  it("pages the relay log with the catch-up cursor shape", async () => {
    server = await makeTestServer();
    const envelopes = [
      testEnvelope({ workspaceId: server.ctx.defaultWorkspace, opType: "object.create", payload: { objectId: crypto.randomUUID() } }),
      testEnvelope({ workspaceId: server.ctx.defaultWorkspace, opType: "object.create", payload: { objectId: crypto.randomUUID() } }),
      testEnvelope({ workspaceId: server.ctx.defaultWorkspace, opType: "object.create", payload: { objectId: crypto.randomUUID() } }),
    ];
    const ingested = await ingest(server, envelopes);
    expect(ingested.statusCode).toBe(200);

    const first = await server.app.inject({
      method: "GET",
      url: "/api/operations?limit=2",
      headers: server.authHeaders,
    });
    expect(first.statusCode).toBe(200);
    const page1 = first.json();
    expect(page1.workspaceId).toBe(server.ctx.defaultWorkspace);
    expect(page1.operations).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.totalRemaining).toBe(3);
    expect(page1.operations[0].id).toBe(envelopes[0]!.id);
    expect(page1.operations[1].id).toBe(envelopes[1]!.id);

    const second = await server.app.inject({
      method: "GET",
      url: `/api/operations?limit=2&afterSeq=${page1.nextAfterSeq}`,
      headers: server.authHeaders,
    });
    expect(second.statusCode).toBe(200);
    const page2 = second.json();
    expect(page2.operations).toHaveLength(1);
    expect(page2.operations[0].id).toBe(envelopes[2]!.id);
    expect(page2.hasMore).toBe(false);
  });

  it("rejects invalid pagination with 422", async () => {
    server = await makeTestServer();
    const response = await server.app.inject({
      method: "GET",
      url: "/api/operations?limit=0",
      headers: server.authHeaders,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("validation_failed");
  });
});

describe("Idempotency-Key (AG5)", () => {
  it("replays the original response without a second write", async () => {
    server = await makeTestServer();
    const body = { name: "idem-page" };
    const headers = { ...server.authHeaders, "idempotency-key": "agent-run-1" };

    const first = await server.app.inject({ method: "POST", url: OBJECTS, headers, payload: body });
    expect(first.statusCode).toBe(201);
    const createdId = first.json().id as string;
    const envelopesAfterFirst = server.ctx.relay.envelopeCount(server.ctx.defaultWorkspace);

    const replay = await server.app.inject({ method: "POST", url: OBJECTS, headers, payload: body });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers[IDEMPOTENCY_REPLAY_HEADER]).toBe("true");
    expect(replay.json().id).toBe(createdId);
    // No second envelope entered the log.
    expect(server.ctx.relay.envelopeCount(server.ctx.defaultWorkspace)).toBe(envelopesAfterFirst);
  });

  it("fails loud (409 idempotency_replay) when the key is reused with a different request", async () => {
    server = await makeTestServer();
    const headers = { ...server.authHeaders, "idempotency-key": "agent-run-2" };
    const first = await server.app.inject({ method: "POST", url: OBJECTS, headers, payload: { name: "one" } });
    expect(first.statusCode).toBe(201);

    const collision = await server.app.inject({
      method: "POST",
      url: OBJECTS,
      headers,
      payload: { name: "two" },
    });
    expect(collision.statusCode).toBe(409);
    expect(collision.json().error.code).toBe("idempotency_replay");
  });

  it("does not cache failures: a fixed retry with the same key executes", async () => {
    server = await makeTestServer();
    const headers = { ...server.authHeaders, "idempotency-key": "agent-run-3" };
    const bad = await server.app.inject({
      method: "POST",
      url: OBJECTS,
      headers,
      payload: { parentId: "not-a-uuid" },
    });
    expect(bad.statusCode).toBe(422);

    const fixed = await server.app.inject({
      method: "POST",
      url: OBJECTS,
      headers,
      payload: { name: "fixed" },
    });
    expect(fixed.statusCode).toBe(201);
    expect(fixed.headers[IDEMPOTENCY_REPLAY_HEADER]).toBeUndefined();
  });
});

describe("baseRevision (AG5)", () => {
  it("409s a stale base and accepts the current one", async () => {
    server = await makeTestServer();
    const created = await server.app.inject({
      method: "POST",
      url: OBJECTS,
      headers: server.authHeaders,
      payload: { name: "rev-page" },
    });
    const id = created.json().id as string;
    const fetched = await server.app.inject({ method: "GET", url: `${OBJECTS}/${id}`, headers: server.authHeaders });
    const base = fetched.json().object.hlc as { physical: number; logical: number };

    const stale = await server.app.inject({
      method: "PATCH",
      url: `${OBJECTS}/${id}`,
      headers: server.authHeaders,
      payload: { icon: "first", baseRevision: base },
    });
    expect(stale.statusCode).toBe(200);
    const newHlc = stale.json().object.hlc as { physical: number; logical: number };
    expect(newHlc).not.toEqual(base);

    const conflict = await server.app.inject({
      method: "PATCH",
      url: `${OBJECTS}/${id}`,
      headers: server.authHeaders,
      payload: { icon: "second", baseRevision: base },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("conflict");

    const noGuard = await server.app.inject({
      method: "PATCH",
      url: `${OBJECTS}/${id}`,
      headers: server.authHeaders,
      payload: { icon: "third" },
    });
    expect(noGuard.statusCode).toBe(200);
  });

  it("rejects a malformed baseRevision with 422", async () => {
    server = await makeTestServer();
    const created = await server.app.inject({
      method: "POST",
      url: OBJECTS,
      headers: server.authHeaders,
      payload: { name: "rev-2" },
    });
    const id = created.json().id as string;
    const response = await server.app.inject({
      method: "PATCH",
      url: `${OBJECTS}/${id}`,
      headers: server.authHeaders,
      payload: { icon: "x", baseRevision: { physical: -1 } },
    });
    expect(response.statusCode).toBe(422);
  });

  it("taken caller-supplied id fails loud with 409 (AB3 owner ruling 2026-10-04)", async () => {
    // §34.33 AB3 resolution (b): the pre-submit existence check makes the
    // v1-parity "a taken id fails loud" contract real. The id-LESS path
    // cannot conflict (server-stamped UUIDv7; retried submits ride the
    // Idempotency-Key replay), so 409 is pinned only for caller-chosen ids.
    server = await makeTestServer();
    const chosenId = crypto.randomUUID();
    const first = await server.app.inject({
      method: "POST",
      url: OBJECTS,
      headers: server.authHeaders,
      payload: { id: chosenId, name: "first-write" },
    });
    expect(first.statusCode).toBe(201);
    const again = await server.app.inject({
      method: "POST",
      url: OBJECTS,
      headers: server.authHeaders,
      payload: { id: chosenId, name: "second-write" },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("conflict");
    // The first write still wins.
    const fetched = await server.app.inject({ method: "GET", url: `${OBJECTS}/${chosenId}`, headers: server.authHeaders });
    expect(fetched.json().object.name).toBe("first-write");
    // Class declaration through the same route honors the same contract.
    const classAgain = await server.app.inject({
      method: "POST",
      url: OBJECTS,
      headers: server.authHeaders,
      payload: { id: chosenId, isClass: true },
    });
    expect(classAgain.statusCode).toBe(409);
    // The id-less path stays a 201 (no conflict is possible there).
    const idLess = await server.app.inject({
      method: "POST",
      url: OBJECTS,
      headers: server.authHeaders,
      payload: { name: "server-stamped" },
    });
    expect(idLess.statusCode).toBe(201);
  });
});

describe("scoped API keys (AG3)", () => {
  async function setupAndKey(scopes?: unknown): Promise<{ session: string; token: string }> {
    const setup = await server!.app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "admin@example.com", password: "admin-password-1" },
    });
    const session = setup.json().token as string;
    const created = await server!.app.inject({
      method: "POST",
      url: "/api/api-keys",
      headers: { authorization: `Bearer ${session}` },
      payload: scopes === undefined ? { name: "machine" } : { name: "machine", scopes },
    });
    expect(created.statusCode).toBe(201);
    return { session, token: created.json().token as string };
  }

  it("read-only scopes pass reads and 403 scope_denied writes", async () => {
    server = await makeTestServer();
    const { token } = await setupAndKey(["objects.read"]);
    const headers = { "x-api-key": token };

    const list = await server.app.inject({ method: "GET", url: OBJECTS, headers });
    expect(list.statusCode).toBe(200);

    const write = await server.app.inject({ method: "POST", url: OBJECTS, headers, payload: { name: "nope" } });
    expect(write.statusCode).toBe(403);
    expect(write.json().error.code).toBe("scope_denied");

    const deleteCall = await server.app.inject({ method: "DELETE", url: `${OBJECTS}/${crypto.randomUUID()}`, headers });
    expect(deleteCall.statusCode).toBe(403);
    expect(deleteCall.json().error.code).toBe("scope_denied");

    const search = await server.app.inject({ method: "GET", url: "/api/search?q=test", headers });
    expect(search.statusCode).toBe(403);
    expect(search.json().error.code).toBe("scope_denied");
  });

  it("keys minted without scopes stay unrestricted", async () => {
    server = await makeTestServer();
    const { token } = await setupAndKey();
    const headers = { "x-api-key": token };
    const write = await server.app.inject({ method: "POST", url: OBJECTS, headers, payload: { name: "yes" } });
    expect(write.statusCode).toBe(201);
  });

  it("scopes are stored on the key record and listed back", async () => {
    server = await makeTestServer();
    const { session, token } = await setupAndKey(["objects.read", "search"]);
    const list = await server.app.inject({
      method: "GET",
      url: "/api/api-keys",
      headers: { authorization: `Bearer ${session}` },
    });
    expect(list.statusCode).toBe(200);
    const keys = list.json().apiKeys as Array<{ scopes: string[] | null }>;
    const scoped = keys.find((key) => key.scopes !== null);
    expect(scoped?.scopes).toEqual(["objects.read", "search"]);
    expect(token).toMatch(/^nk_/);
  });

  it("rejects unknown scope names with 422", async () => {
    server = await makeTestServer();
    const setup = await server.app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "admin@example.com", password: "admin-password-1" },
    });
    const session = setup.json().token as string;
    const created = await server.app.inject({
      method: "POST",
      url: "/api/api-keys",
      headers: { authorization: `Bearer ${session}` },
      payload: { name: "bad", scopes: ["objects.own"] },
    });
    expect(created.statusCode).toBe(422);
    expect(created.json().error.code).toBe("validation_failed");
  });

  it("scoped keys are rejected on the relay surface with 403 scope_denied", async () => {
    server = await makeTestServer();
    const { token } = await setupAndKey(["objects.read"]);
    const headers = { "x-api-key": token };
    const batch = await ingest(server, [testEnvelope({ opType: "object.create", payload: { objectId: crypto.randomUUID() } })]);
    // ingest uses the operator key — redo with the scoped key explicitly.
    const scopedBatch = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/batch",
      headers: { "content-type": "application/json", ...headers },
      payload: { envelopes: [testEnvelope({ opType: "object.create", payload: { objectId: crypto.randomUUID() } })] },
    });
    expect(scopedBatch.statusCode).toBe(403);
    expect(scopedBatch.json().error.code).toBe("scope_denied");

    const catchUp = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/catch-up",
      headers: { "content-type": "application/json", ...headers },
      payload: { workspaceId: server.ctx.defaultWorkspace },
    });
    expect(catchUp.statusCode).toBe(403);
    expect(catchUp.json().error.code).toBe("scope_denied");
    expect(batch.statusCode).toBe(200);
  });

  it("a scoped read key can still page the operation feed", async () => {
    server = await makeTestServer();
    const { token } = await setupAndKey(["objects.read"]);
    const feed = await server.app.inject({
      method: "GET",
      url: "/api/operations?limit=5",
      headers: { "x-api-key": token },
    });
    expect(feed.statusCode).toBe(200);
    expect(Array.isArray(feed.json().operations)).toBe(true);
  });
});
