/**
 * Workspace-key route tests — the E2EE custody surface.
 *
 * Authorization shape (Review Focus 1): an authenticated user WITH workspace
 * membership reads/writes the opaque wrapped key; a user without membership
 * gets 404 on GET (key existence is not revealed) and 403 on PUT; the
 * operator API key gets 403 on both (keys are user custody, not operator);
 * unauthenticated callers get 401.
 */

import { afterEach, describe, expect, it } from "vitest";

import { closeTestServer, makeTestServer, testEnvelope, type TestServer } from "./helpers";

let server: TestServer | null = null;
afterEach(async () => {
  if (server !== null) {
    await closeTestServer(server);
    server = null;
  }
});

async function setupUser(email = "admin@example.com"): Promise<{ token: string }> {
  const response = await server!.app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { email, password: "admin-password-1" },
  });
  expect(response.statusCode).toBe(201);
  return { token: response.json().token as string };
}

function createSecondUser(): { token: string; userId: string } {
  const user = server!.ctx.auth.createUser({
    email: "second@example.com",
    passwordHash: "scrypt$16384$8$1$c2FsdA$hZ2ZoaDZk",
  });
  return { token: server!.ctx.auth.createSession(user.id).token, userId: user.id };
}

async function createWorkspace(token: string): Promise<string> {
  const response = await server!.app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers: { authorization: `Bearer ${token}` },
    payload: { name: "keyed" },
  });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

describe("workspace-key routes", () => {
  it("member PUT then GET round-trips the wrapped key", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const workspaceId = await createWorkspace(token);

    const put = await server.app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspaceId}/key`,
      headers: { authorization: `Bearer ${token}` },
      payload: { wrappedKey: "b64u-opaque-wrapped-key" },
    });
    expect(put.statusCode).toBe(204);

    const get = await server.app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/key`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ wrappedKey: "b64u-opaque-wrapped-key" });
  });

  it("GET 404s when no key row exists (without revealing anything else)", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const workspaceId = await createWorkspace(token);

    const get = await server.app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/key`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.statusCode).toBe(404);
  });

  it("non-member GET 404s and non-member PUT 403s", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const workspaceId = await createWorkspace(token);
    const outsider = createSecondUser();

    const get = await server.app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/key`,
      headers: { authorization: `Bearer ${outsider.token}` },
    });
    expect(get.statusCode).toBe(404);

    const put = await server.app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspaceId}/key`,
      headers: { authorization: `Bearer ${outsider.token}` },
      payload: { wrappedKey: "b64u-opaque-wrapped-key" },
    });
    expect(put.statusCode).toBe(403);
  });

  it("unauthenticated callers get 401 on both", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const workspaceId = await createWorkspace(token);

    const get = await server.app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/key` });
    expect(get.statusCode).toBe(401);
    const put = await server.app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspaceId}/key`,
      payload: { wrappedKey: "b64u-opaque-wrapped-key" },
    });
    expect(put.statusCode).toBe(401);
  });

  it("the operator API key gets 403 on both (user custody, not operator)", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const workspaceId = await createWorkspace(token);
    const headers = { "x-api-key": server.apiKey };

    const get = await server.app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/key`, headers });
    expect(get.statusCode).toBe(403);
    const put = await server.app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspaceId}/key`,
      headers,
      payload: { wrappedKey: "b64u-opaque-wrapped-key" },
    });
    expect(put.statusCode).toBe(403);
  });

  it("rejects an invalid body (missing/oversized wrappedKey) with 422", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const workspaceId = await createWorkspace(token);
    const headers = { authorization: `Bearer ${token}` };

    const missing = await server.app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspaceId}/key`,
      headers,
      payload: {},
    });
    expect(missing.statusCode).toBe(422);

    const oversized = await server.app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspaceId}/key`,
      headers,
      payload: { wrappedKey: "x".repeat(4097) },
    });
    expect(oversized.statusCode).toBe(422);
  });

  it("first write wins: a second PUT is rejected with 409 and the stored key is untouched", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const workspaceId = await createWorkspace(token);
    const headers = { authorization: `Bearer ${token}` };

    const first = await server.app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspaceId}/key`,
      headers,
      payload: { wrappedKey: "wrapped-key-A" },
    });
    expect(first.statusCode).toBe(204);

    const second = await server.app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspaceId}/key`,
      headers,
      payload: { wrappedKey: "wrapped-key-B" },
    });
    expect(second.statusCode).toBe(409);

    const get = await server.app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/key`,
      headers,
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ wrappedKey: "wrapped-key-A" });
  });

  it("non-member PUT with an invalid body is rejected 403 BEFORE body validation (no existence/validity leak)", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const workspaceId = await createWorkspace(token);
    const outsider = createSecondUser();

    const response = await server.app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspaceId}/key`,
      headers: { authorization: `Bearer ${outsider.token}` },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("key-gated content reads (plan-07 ruling)", () => {
  async function seedContent(workspaceId: string): Promise<{ nodeId: string; schemaId: string }> {
    // A page + a property value, through the relay (the object API is retired).
    const nodeId = crypto.randomUUID();
    const schemaId = crypto.randomUUID();
    const batch = await server!.app.inject({
      method: "POST",
      url: "/api/relay/v2/batch",
      headers: { "content-type": "application/json", "x-workspace-id": workspaceId, ...server!.authHeaders },
      payload: {
        envelopes: [
          testEnvelope({ workspaceId, opType: "object.create", payload: { objectId: nodeId, isEmbedded: false, contentAst: [{ type: "text", text: "Gated page" }] } }),
          testEnvelope({ workspaceId, opType: "propertySchema.create", payload: { propertySchemaId: schemaId, name: "gate-schema", type: "text" } }),
          testEnvelope({ workspaceId, opType: "property.set", payload: { objectId: nodeId, propertySchemaId: schemaId, value: "gated-value", idx: 0 } }),
        ],
      },
    });
    expect(batch.statusCode).toBe(200);
    return { nodeId, schemaId };
  }

  async function assertGated(workspaceId: string, schemaId: string): Promise<void> {
    const headers = { "x-workspace-id": workspaceId, ...server!.authHeaders };
    for (const url of [
      `/api/resolve?name=${encodeURIComponent("Gated page")}`,
      `/api/classes`,
      `/api/classes/${crypto.randomUUID()}`,
      `/api/properties/${schemaId}/values`,
    ]) {
      const response = await server!.app.inject({ method: "GET", url, headers });
      expect(response.statusCode, url).toBe(404);
      expect(response.json().error.message, url).toContain("content reads are client-side");
    }
  }

  it("a keyed workspace gets NO content reads; a keyless workspace keeps them", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const headers = { authorization: `Bearer ${token}` };

    const keyless = await createWorkspace(token);
    const keylessContent = await seedContent(keyless);
    const keylessHeaders = { "x-workspace-id": keyless, ...server.authHeaders };
    expect((await server.app.inject({ method: "GET", url: `/api/resolve?name=${encodeURIComponent("Gated page")}`, headers: keylessHeaders })).statusCode).toBe(200);
    expect((await server.app.inject({ method: "GET", url: `/api/classes`, headers: keylessHeaders })).statusCode).toBe(200);
    expect((await server.app.inject({ method: "GET", url: `/api/properties/${keylessContent.schemaId}/values`, headers: keylessHeaders })).statusCode).toBe(200);

    const keyed = await createWorkspace(token);
    const keyedContent = await seedContent(keyed);
    void headers;
    server.ctx.auth.putWorkspaceKey(keyed, "b64u-opaque-wrapped-key");
    await assertGated(keyed, keyedContent.schemaId);
  });
});
