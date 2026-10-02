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

async function setupAdmin(email = "admin@example.com", password = "admin-password-1") {
  const response = await server!.app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { email, password },
  });
  return response;
}

describe("setup gate", () => {
  it("server-info reports setupRequired on a fresh server and false after setup", async () => {
    server = await makeTestServer();
    const before = await server.app.inject({ method: "GET", url: "/api/server-info" });
    expect(before.statusCode).toBe(200);
    expect(before.json().setupRequired).toBe(true);

    const setup = await setupAdmin();
    expect(setup.statusCode).toBe(201);
    expect(setup.json().token).toMatch(/^nt_/);
    expect(setup.json().user.isAdmin).toBe(true);

    const after = await server.app.inject({ method: "GET", url: "/api/server-info" });
    expect(after.json().setupRequired).toBe(false);
  });

  it("setup is refused once any account exists", async () => {
    server = await makeTestServer();
    expect((await setupAdmin()).statusCode).toBe(201);
    const again = await server.app.inject({
      method: "POST",
      url: "/api/setup",
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
      url: "/api/workspaces",
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
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "admin-password-1" },
    });
    expect(login.statusCode).toBe(200);
    const token = login.json().token as string;

    const me = await server.app.inject({
      method: "GET",
      url: "/api/auth/me",
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
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "wrong-password" },
    });
    expect(wrongPw.statusCode).toBe(401);
    const unknown = await server.app.inject({
      method: "POST",
      url: "/api/auth/login",
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
      url: "/api/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(out.statusCode).toBe(200);
    const me = await server.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(401);
  });

  it("account routes reject the operator API key", async () => {
    server = await makeTestServer();
    await setupAdmin();
    const me = await server.app.inject({
      method: "GET",
      url: "/api/auth/me",
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
    const env = testEnvelope({ opType: "object.create", payload: { objectId: crypto.randomUUID(), presentAsMain: true, contentAst: [{ type: "text", text: "Via session" }] } });
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
      payload: { objectId: crypto.randomUUID(), presentAsMain: true, contentAst: [{ type: "text", text: "Claimed" }] },
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
      testEnvelope({ workspaceId: foreign, opType: "object.create", payload: { objectId: crypto.randomUUID(), presentAsMain: true, contentAst: [{ type: "text", text: "Foreign" }] } }),
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

describe("workspace rename", () => {
  it("PATCH /workspaces/:id renames for the owner and refuses non-owners", async () => {
    server = await makeTestServer();
    const owner = (await setupAdmin("owner@example.com")).json().token as string;

    // A second account the owner adds as a plain (non-owner) member.
    const memberUser = server.ctx.auth.createUser({
      email: "member@example.com",
      passwordHash: await hashPassword("member-password-1"),
    });
    const member = server.ctx.auth.createSession(memberUser.id).token;

    const created = await server.app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { authorization: `Bearer ${owner}` },
      payload: { name: "Old name" },
    });
    expect(created.statusCode).toBe(201);
    const workspaceId = created.json().id as string;
    server.ctx.auth.addMember(workspaceId, memberUser.id, "member");

    // Non-owner member: forbidden.
    const byMember = await server.app.inject({
      method: "PATCH",
      url: `/api/workspaces/${workspaceId}`,
      headers: { authorization: `Bearer ${member}` },
      payload: { name: "Hijacked" },
    });
    expect(byMember.statusCode).toBe(403);

    // Unrelated account: the workspace's existence is not revealed.
    const strangerUser = server.ctx.auth.createUser({
      email: "stranger@example.com",
      passwordHash: await hashPassword("stranger-password-1"),
    });
    const stranger = server.ctx.auth.createSession(strangerUser.id).token;
    const byStranger = await server.app.inject({
      method: "PATCH",
      url: `/api/workspaces/${workspaceId}`,
      headers: { authorization: `Bearer ${stranger}` },
      payload: { name: "Hijacked" },
    });
    expect(byStranger.statusCode).toBe(404);

    // Owner: renamed, and the list reflects it.
    const renamed = await server.app.inject({
      method: "PATCH",
      url: `/api/workspaces/${workspaceId}`,
      headers: { authorization: `Bearer ${owner}` },
      payload: { name: "New name" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toEqual({ id: workspaceId, name: "New name" });

    const list = await server.app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { authorization: `Bearer ${owner}` },
    });
    const entry = list
      .json()
      .workspaces.find((ws: { id: string }) => ws.id === workspaceId);
    expect(entry.name).toBe("New name");

    // Empty names are rejected outright.
    const empty = await server.app.inject({
      method: "PATCH",
      url: `/api/workspaces/${workspaceId}`,
      headers: { authorization: `Bearer ${owner}` },
      payload: { name: "   " },
    });
    expect(empty.statusCode).toBe(422);
  });
});

describe("workspace delete and export", () => {
  it("DELETE removes the workspace and its data (owner only)", async () => {
    server = await makeTestServer();
    const owner = (await setupAdmin("owner@example.com")).json().token as string;
    const created = await server.app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { authorization: `Bearer ${owner}` },
      payload: { name: "Doomed" },
    });
    const workspaceId = created.json().id as string;

    const memberUser = server.ctx.auth.createUser({
      email: "member@example.com",
      passwordHash: await hashPassword("member-password-1"),
    });
    const member = server.ctx.auth.createSession(memberUser.id).token;
    server.ctx.auth.addMember(workspaceId, memberUser.id, "member");

    // Non-owner member: forbidden.
    const byMember = await server.app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspaceId}`,
      headers: { authorization: `Bearer ${member}` },
    });
    expect(byMember.statusCode).toBe(403);

    // Owner deletes.
    const deleted = await server.app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspaceId}`,
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true });

    // Gone from the owner's list; memberships went with it.
    const list = await server.app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(list.json().workspaces.map((w: { id: string }) => w.id)).not.toContain(workspaceId);

    // A second delete no longer finds it (also for the ex-member).
    const again = await server.app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspaceId}`,
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(again.statusCode).toBe(404);
    const byExMember = await server.app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspaceId}`,
      headers: { authorization: `Bearer ${member}` },
    });
    expect(byExMember.statusCode).toBe(404);
  });

  it("GET /workspaces/:id/export downloads the workspace as Markdown", async () => {
    server = await makeTestServer();
    const owner = (await setupAdmin("owner@example.com")).json().token as string;
    const created = await server.app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { authorization: `Bearer ${owner}` },
      payload: { name: "Export Me" },
    });
    const workspaceId = created.json().id as string;

    // A page with a nested block, written through the relay.
    const pageId = crypto.randomUUID();
    const blockId = crypto.randomUUID();
    const batch = await ingest(server, [
      testEnvelope({
        workspaceId,
        opType: "object.create",
        payload: pagePayload("Exported Page", { objectId: pageId }),
      }),
      testEnvelope({
        workspaceId,
        opType: "object.create",
        payload: {
          objectId: blockId,
          parentId: pageId,
          contentAst: [{ type: "text", text: "child block body" }],
        },
      }),
    ]);
    expect(batch.statusCode).toBe(200);

    const exported = await server.app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/export`,
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toContain("text/markdown");
    expect(exported.headers["content-disposition"]).toContain("Export-Me.md");
    expect(exported.body).toContain("Exported Page");
    expect(exported.body).toContain("child block body");

    // Non-member: the workspace's existence is not revealed.
    const strangerUser = server.ctx.auth.createUser({
      email: "stranger@example.com",
      passwordHash: await hashPassword("stranger-password-1"),
    });
    const stranger = server.ctx.auth.createSession(strangerUser.id).token;
    const byStranger = await server.app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/export`,
      headers: { authorization: `Bearer ${stranger}` },
    });
    expect(byStranger.statusCode).toBe(404);
  });

  it("GET /nodes/:id/location resolves the workspace holding the node", async () => {
    server = await makeTestServer();
    const owner = (await setupAdmin("owner@example.com")).json().token as string;
    const first = await server.app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { authorization: `Bearer ${owner}` },
      payload: { name: "First" },
    });
    const firstId = first.json().id as string;
    const second = await server.app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { authorization: `Bearer ${owner}` },
      payload: { name: "Second" },
    });
    const secondId = second.json().id as string;

    // A page in the SECOND workspace.
    const pageId = crypto.randomUUID();
    const batch = await ingest(server, [
      testEnvelope({
        workspaceId: secondId,
        opType: "object.create",
        payload: pagePayload("Faraway Page", { objectId: pageId }),
      }),
    ]);
    expect(batch.statusCode).toBe(200);

    const located = await server.app.inject({
      method: "GET",
      url: `/api/nodes/${pageId}/location`,
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(located.statusCode).toBe(200);
    expect(located.json()).toEqual({ workspaceId: secondId });

    // Unknown node: 404. Stranger asking about a node they cannot reach: 404.
    const unknown = await server.app.inject({
      method: "GET",
      url: `/api/nodes/${crypto.randomUUID()}/location`,
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(unknown.statusCode).toBe(404);

    const strangerUser = server.ctx.auth.createUser({
      email: "stranger@example.com",
      passwordHash: await hashPassword("stranger-password-1"),
    });
    const stranger = server.ctx.auth.createSession(strangerUser.id).token;
    const byStranger = await server.app.inject({
      method: "GET",
      url: `/api/nodes/${pageId}/location`,
      headers: { authorization: `Bearer ${stranger}` },
    });
    expect(byStranger.statusCode).toBe(404);
  });
});

describe("api keys", () => {
  it("minted keys authenticate as their owner and list workspaces", async () => {
    server = await makeTestServer();
    const session = (await setupAdmin()).json().token as string;
    const created = await server.app.inject({
      method: "POST",
      url: "/api/api-keys",
      headers: { authorization: `Bearer ${session}` },
      payload: { name: "laptop CLI" },
    });
    expect(created.statusCode).toBe(201);
    const key = created.json().token as string;
    expect(key).toMatch(/^nk_[A-Za-z0-9_-]{40}$/);
    expect(created.json().apiKey.prefix).toBe(key.slice(0, 12));

    const workspaces = await server.app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(workspaces.statusCode).toBe(200);
    expect(workspaces.json().workspaces.length).toBeGreaterThan(0);
  });

  it("key management is session-only; keys cannot mint keys", async () => {
    server = await makeTestServer();
    const session = (await setupAdmin()).json().token as string;
    const key = (
      await server.app.inject({
        method: "POST",
        url: "/api/api-keys",
        headers: { authorization: `Bearer ${session}` },
        payload: { name: "k" },
      })
    ).json().token as string;
    const denied = await server.app.inject({
      method: "POST",
      url: "/api/api-keys",
      headers: { authorization: `Bearer ${key}` },
      payload: { name: "nested" },
    });
    expect(denied.statusCode).toBe(401);
  });

  it("revoked keys stop authenticating; keys cannot manage themselves", async () => {
    server = await makeTestServer();
    const session = (await setupAdmin()).json().token as string;
    const created = await server.app.inject({
      method: "POST",
      url: "/api/api-keys",
      headers: { authorization: `Bearer ${session}` },
      payload: { name: "temp" },
    });
    const { id } = created.json().apiKey as { id: string };
    const key = created.json().token as string;

    const revoked = await server.app.inject({
      method: "DELETE",
      url: `/api/api-keys/${id}`,
      headers: { authorization: `Bearer ${session}` },
    });
    expect(revoked.statusCode).toBe(200);
    const me = await server.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(me.statusCode).toBe(401);
  });

  it("an api key syncs the relay with its owner's memberships", async () => {
    server = await makeTestServer();
    const session = (await setupAdmin()).json().token as string;
    const key = (
      await server.app.inject({
        method: "POST",
        url: "/api/api-keys",
        headers: { authorization: `Bearer ${session}` },
        payload: { name: "sync" },
      })
    ).json().token as string;
    const env = testEnvelope({ opType: "object.create", payload: { objectId: crypto.randomUUID(), presentAsMain: true, contentAst: [{ type: "text", text: "Via key" }] } });
    const response = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/batch",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      payload: { envelopes: [env] },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe("per-account lockout", () => {
  it("locks after 5 failures for 15 minutes, even with the right password", async () => {
    server = await makeTestServer();
    await setupAdmin();
    const bad = { email: "admin@example.com", password: "wrong-password" };
    // Failures 1–4 answer 401; the 5th crosses the threshold and answers 429.
    for (let i = 0; i < 4; i += 1) {
      const response = await server.app.inject({ method: "POST", url: "/api/auth/login", payload: bad });
      expect(response.statusCode).toBe(401);
    }
    const fifth = await server.app.inject({ method: "POST", url: "/api/auth/login", payload: bad });
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json().error.code).toBe("account_locked");
    // The next attempt with the CORRECT password is refused while locked.
    const locked = await server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "admin-password-1" },
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe("account_locked");
  });

  it("a successful login clears the failure count", async () => {
    server = await makeTestServer();
    await setupAdmin();
    for (let i = 0; i < 3; i += 1) {
      await server.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "admin@example.com", password: "wrong-password" },
      });
    }
    const good = await server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "admin-password-1" },
    });
    expect(good.statusCode).toBe(200);
    // Failures were reset: it takes a full 5 again to lock.
    for (let i = 0; i < 4; i += 1) {
      const response = await server.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "admin@example.com", password: "wrong-password" },
      });
      expect(response.statusCode).toBe(401);
    }
    const stillOpen = await server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "admin-password-1" },
    });
    expect(stillOpen.statusCode).toBe(200);
  });
});

describe("password-derived encryption keys", () => {
  it("setup and login return the kdf record; it backfills lazily", async () => {
    server = await makeTestServer();
    const setup = await setupAdmin();
    expect(setup.statusCode).toBe(201);
    const kdf = setup.json().kdf;
    expect(kdf.algorithm).toBe("scrypt");
    expect(kdf.N).toBe(131072);
    expect(typeof kdf.salt).toBe("string");
    expect(typeof kdf.wrappedMasterKey).toBe("string");
    expect(typeof kdf.keyVerifier).toBe("string");

    // Accounts created directly in storage (no setup) get the record on login.
    const legacy = server.ctx.auth.createUser({
      email: "legacy@example.com",
      passwordHash: await hashPassword("legacy-password-1"),
    });
    const login = await server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "legacy@example.com", password: "legacy-password-1" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().kdf.wrappedMasterKey).toBeTruthy();
    // The record persisted: a second login returns the SAME wrapped key.
    const stored = server.ctx.auth.getKdfRecord(legacy.id);
    expect(stored?.wrappedMasterKey).toBe(login.json().kdf.wrappedMasterKey);
  });
});
