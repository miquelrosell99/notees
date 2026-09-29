/**
 * Account auth tests: the setup gate, login/logout, sessions, the workspace
 * list, and relay authorization for account principals (claim-on-first-write,
 * read denial for non-members) — with the operator API key kept as the
 * unrestricted legacy principal.
 */

import { afterEach, describe, expect, it } from "vitest";

import { hashPassword } from "../src/auth.js";
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

async function setupAdmin(email = "admin@example.com", password = "admin-password-1") {
  const response = await server!.app.inject({
    method: "POST",
    url: "/api/v1/setup",
    payload: { email, password },
  });
  return response;
}

describe("setup gate", () => {
  it("server-info reports setupRequired on a fresh server and false after setup", async () => {
    server = await makeTestServer();
    const before = await server.app.inject({ method: "GET", url: "/api/v1/server-info" });
    expect(before.statusCode).toBe(200);
    expect(before.json().setupRequired).toBe(true);

    const setup = await setupAdmin();
    expect(setup.statusCode).toBe(201);
    expect(setup.json().token).toMatch(/^nt_/);
    expect(setup.json().user.isAdmin).toBe(true);

    const after = await server.app.inject({ method: "GET", url: "/api/v1/server-info" });
    expect(after.json().setupRequired).toBe(false);
  });

  it("setup is refused once any account exists", async () => {
    server = await makeTestServer();
    expect((await setupAdmin()).statusCode).toBe(201);
    const again = await server.app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: { email: "other@example.com", password: "admin-password-2" },
    });
    expect(again.statusCode).toBe(409);
  });

  it("setup claims the default workspace for the first account", async () => {
    server = await makeTestServer();
    const setup = await setupAdmin();
    const token = setup.json().token as string;
    const list = await server.app.inject({
      method: "GET",
      url: "/api/v1/workspaces",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    const ids = list.json().workspaces.map((ws: { id: string }) => ws.id);
    expect(ids).toContain(server.ctx.defaultWorkspace);
  });
});

describe("login and sessions", () => {
  it("login returns a session that authenticates account routes", async () => {
    server = await makeTestServer();
    await setupAdmin();
    const login = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@example.com", password: "admin-password-1" },
    });
    expect(login.statusCode).toBe(200);
    const token = login.json().token as string;

    const me = await server.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe("admin@example.com");
  });

  it("wrong password and unknown email both yield 401", async () => {
    server = await makeTestServer();
    await setupAdmin();
    const wrongPw = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@example.com", password: "wrong-password" },
    });
    expect(wrongPw.statusCode).toBe(401);
    const unknown = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "nobody@example.com", password: "admin-password-1" },
    });
    expect(unknown.statusCode).toBe(401);
  });

  it("logout revokes the session", async () => {
    server = await makeTestServer();
    const setup = await setupAdmin();
    const token = setup.json().token as string;
    const out = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(out.statusCode).toBe(200);
    const me = await server.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(401);
  });

  it("account routes reject the operator API key", async () => {
    server = await makeTestServer();
    await setupAdmin();
    const me = await server.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: server.authHeaders,
    });
    expect(me.statusCode).toBe(401);
  });
});

describe("relay authorization for accounts", () => {
  it("a session token works as the relay credential", async () => {
    server = await makeTestServer();
    const setup = await setupAdmin();
    const token = setup.json().token as string;
    const env = testEnvelope({ opType: "object.create", payload: { objectId: crypto.randomUUID(), nodeType: "page", name: "Via session" } });
    const response = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/batch",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      payload: { envelopes: [env] },
    });
    expect(response.statusCode).toBe(200);
  });

  it("first write claims an unclaimed workspace; a second account is denied", async () => {
    server = await makeTestServer();
    const setup = await setupAdmin("one@example.com");
    const first = setup.json().token as string;
    const secondUser = server.ctx.auth.createUser({
      email: "two@example.com",
      passwordHash: await hashPassword("second-password-1"),
    });
    const second = server.ctx.auth.createSession(secondUser.id).token;

    const workspace = "22222222-3333-4444-8555-666666666666";
    // First account writes → claims the workspace.
    const env = testEnvelope({
      workspaceId: workspace,
      opType: "object.create",
      payload: { objectId: crypto.randomUUID(), nodeType: "page", name: "Claimed" },
    });
    const write = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/batch",
      headers: { "content-type": "application/json", authorization: `Bearer ${first}` },
      payload: { envelopes: [env] },
    });
    expect(write.statusCode).toBe(200);

    // Second account: read and write both denied.
    const read = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/catch-up",
      headers: { "content-type": "application/json", authorization: `Bearer ${second}` },
      payload: { workspaceId: workspace, afterSeq: 0 },
    });
    expect(read.statusCode).toBe(403);
    const write2 = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/batch",
      headers: { "content-type": "application/json", authorization: `Bearer ${second}` },
      payload: { envelopes: [env] },
    });
    expect(write2.statusCode).toBe(403);
  });

  it("read (catch-up) is denied for a non-member", async () => {
    server = await makeTestServer();
    const setup = await setupAdmin();
    const token = setup.json().token as string;
    const foreign = "22222222-3333-4444-8555-666666666666";
    // Seed the foreign workspace via the operator key, then attempt a read
    // with the account token (membership exists only on the default ws).
    await ingest(server, [
      testEnvelope({ workspaceId: foreign, opType: "object.create", payload: { objectId: crypto.randomUUID(), nodeType: "page", name: "Foreign" } }),
    ]);
    const response = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/catch-up",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      payload: { workspaceId: foreign, afterSeq: 0 },
    });
    expect(response.statusCode).toBe(403);
  });

  it("the operator API key keeps unrestricted access", async () => {
    server = await makeTestServer();
    const foreign = "22222222-3333-4444-8555-666666666666";
    const response = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/catch-up",
      headers: { "content-type": "application/json", ...server.authHeaders },
      payload: { workspaceId: foreign, afterSeq: 0 },
    });
    expect(response.statusCode).toBe(200);
  });
});
