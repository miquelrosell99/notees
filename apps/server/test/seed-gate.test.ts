/**
 * Seed-shim gate: the server seeds ONLY keyless workspaces. A workspace that
 * carries a `workspace_key` row is client-seeded (the client stamps the
 * system seeds with its own device and pushes them encrypted); the server
 * must never write plaintext seeds into it. Keyless workspaces keep the
 * server shim that GTK/Flutter/CLI rely on today.
 */

import { afterEach, describe, expect, it } from "vitest";

import { closeTestServer, makeTestServer, type TestServer } from "./helpers";

let server: TestServer | null = null;
afterEach(async () => {
  if (server !== null) {
    await closeTestServer(server);
    server = null;
  }
});

async function setupUser(): Promise<{ token: string }> {
  const response = await server!.app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { email: "admin@example.com", password: "admin-password-1" },
  });
  expect(response.statusCode).toBe(201);
  return { token: response.json().token as string };
}

async function createWorkspace(token: string): Promise<string> {
  const response = await server!.app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers: { authorization: `Bearer ${token}` },
    payload: { name: "seed-target" },
  });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

function envelopeCount(workspaceId: string): number {
  return server!.ctx.relay.stats(workspaceId).envelopeCount;
}

describe("seed shim gate", () => {
  it("a keyless workspace seeds as today (server shim)", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const workspaceId = await createWorkspace(token);

    const result = await server.ctx.ensureSeeded(workspaceId);
    expect(result.seededCount).toBeGreaterThan(0);
    expect(envelopeCount(workspaceId)).toBeGreaterThan(0);
  });

  it("a workspace WITH a workspace_key row stays empty (client-seeded only)", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const workspaceId = await createWorkspace(token);
    server.ctx.auth.putWorkspaceKey(workspaceId, "b64u-opaque-wrapped-key");

    const result = await server.ctx.ensureSeeded(workspaceId);

    expect(result.seededCount).toBe(0);
    expect(envelopeCount(workspaceId)).toBe(0);
    const store = server.ctx.workspaces.storeFor(workspaceId);
    const row = store.database.prepare("SELECT COUNT(*) AS n FROM node").get() as { n: number };
    expect(row.n).toBe(0);
  });
});
