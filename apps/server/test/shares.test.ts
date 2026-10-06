/**
 * Share tests — READ-ONLY public page shares:
 *
 *  - mint/list/revoke management surface + its owner/admin auth gates
 *    (operator key, admin session, owner membership pass; strangers and
 *    plain members get 401/403);
 *  - the public GET /s/:token view: static read-only HTML (content present,
 *    escaped, NO script/app chrome), GET-only, sane cache/security headers;
 *  - revocation/expiry/trash all answer the same indistinguishable 404.
 */

import { afterEach, describe, expect, it } from "vitest";

import { hashPassword } from "../src/auth.js";
import { closeTestServer, makeTestServer, type TestServer } from "./helpers";

let server: TestServer | null = null;
afterEach(async () => {
  if (server !== null) {
    await closeTestServer(server);
    server = null;
  }
});

async function createNode(
  body: Record<string, unknown>,
): Promise<{ id: string; response: Awaited<ReturnType<TestServer["app"]["inject"]>> }> {
  const response = await server!.app.inject({
    method: "POST",
    url: "/api/objects",
    headers: server!.authHeaders,
    payload: body,
  });
  return { id: response.json().id as string, response };
}

function pageBody(title: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    presentAsMain: true,
    contentAst: [{ type: "text", text: title }],
    ...extra,
  };
}

async function mintShare(
  nodeId: string,
  headers: Record<string, string>,
  extra: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<TestServer["app"]["inject"]>>> {
  return server!.app.inject({
    method: "POST",
    url: "/api/shares",
    headers: { "content-type": "application/json", ...headers },
    payload: { nodeId, ...extra },
  });
}

async function setupAdmin(): Promise<string> {
  const response = await server!.app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { email: "admin@example.com", password: "admin-password-1" },
  });
  return response.json().token as string;
}

async function mintUserSession(email: string, role: string | null): Promise<string> {
  const user = server!.ctx.auth.createUser({
    email,
    passwordHash: await hashPassword(`${email}-password`),
  });
  if (role !== null) server!.ctx.auth.addMember(server!.ctx.defaultWorkspace, user.id, role);
  return server!.ctx.auth.createSession(user.id).token;
}

describe("share management", () => {
  it("mints a share with an unguessable token and the public urlPath", async () => {
    server = await makeTestServer();
    const page = await createNode(pageBody("Quarterly plan"));
    const minted = await mintShare(page.id, server.authHeaders);
    expect(minted.statusCode).toBe(201);
    const share = minted.json().share;
    expect(share.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(share.urlPath).toBe(`/s/${share.token}`);
    expect(share.nodeId).toBe(page.id);
    expect(share.workspaceId).toBe(server.ctx.defaultWorkspace);
    expect(share.expiresAt).toBeNull();
    expect(share.revokedAt).toBeNull();
    expect(share.createdBy).toBe(server.ctx.actorId); // operator key principal
  });

  it("records the minting user id for session principals", async () => {
    server = await makeTestServer();
    const admin = await setupAdmin();
    const page = await createNode(pageBody("Admin page"));
    const minted = await mintShare(page.id, { authorization: `Bearer ${admin}` });
    expect(minted.statusCode).toBe(201);
    expect(minted.json().share.createdBy).not.toBe(server.ctx.actorId);
  });

  it("lists shares newest-first and filters by nodeId", async () => {
    server = await makeTestServer();
    const a = await createNode(pageBody("Page A"));
    const b = await createNode(pageBody("Page B"));
    await mintShare(a.id, server.authHeaders);
    await mintShare(a.id, server.authHeaders);
    await mintShare(b.id, server.authHeaders);

    const all = await server.app.inject({ method: "GET", url: "/api/shares", headers: server.authHeaders });
    expect(all.statusCode).toBe(200);
    expect(all.json().shares).toHaveLength(3);

    const filtered = await server.app.inject({
      method: "GET",
      url: `/api/shares?nodeId=${a.id}`,
      headers: server.authHeaders,
    });
    expect(filtered.statusCode).toBe(200);
    const shares = filtered.json().shares;
    expect(shares).toHaveLength(2);
    expect(shares.every((s: { nodeId: string }) => s.nodeId === a.id)).toBe(true);
    // newest first
    expect(shares[0].createdAt).toBeGreaterThanOrEqual(shares[1].createdAt);
  });

  it("revocation is immediate and idempotent-listing keeps the history", async () => {
    server = await makeTestServer();
    const page = await createNode(pageBody("Revocable"));
    const minted = await mintShare(page.id, server.authHeaders);
    const token = minted.json().share.token as string;

    const revoked = await server.app.inject({
      method: "DELETE",
      url: `/api/shares/${token}`,
      headers: server.authHeaders,
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().ok).toBe(true);

    // The public view dies on the next request.
    const view = await server.app.inject({ method: "GET", url: `/s/${token}` });
    expect(view.statusCode).toBe(404);

    // A second revoke 404s; the list still carries the revoked row.
    const again = await server.app.inject({
      method: "DELETE",
      url: `/api/shares/${token}`,
      headers: server.authHeaders,
    });
    expect(again.statusCode).toBe(404);
    const list = await server.app.inject({
      method: "GET",
      url: `/api/shares?nodeId=${page.id}`,
      headers: server.authHeaders,
    });
    const shares = list.json().shares;
    expect(shares).toHaveLength(1);
    expect(shares[0].revokedAt).not.toBeNull();
  });

  it("accepts a future expiresAt and rejects a past one", async () => {
    server = await makeTestServer();
    const page = await createNode(pageBody("Expiring"));
    const future = await mintShare(page.id, server.authHeaders, {
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    expect(future.statusCode).toBe(201);
    expect(future.json().share.expiresAt).not.toBeNull();

    const past = await mintShare(page.id, server.authHeaders, { expiresAt: Date.now() - 1000 });
    expect(past.statusCode).toBe(422);
    expect(past.json().error.code).toBe("validation_failed");
  });

  it("fails loud on bad input: unknown node, class node, malformed body", async () => {
    server = await makeTestServer();
    const missing = await mintShare("0192a000-0000-7000-8000-000000000099", server.authHeaders);
    expect(missing.statusCode).toBe(404);

    const klass = await createNode({ isClass: true, contentAst: [{ type: "text", text: "A class" }] });
    const classShare = await mintShare(klass.id, server.authHeaders);
    expect(classShare.statusCode).toBe(422);

    const noBody = await server.app.inject({
      method: "POST",
      url: "/api/shares",
      headers: { "content-type": "application/json", ...server.authHeaders },
      payload: {},
    });
    expect(noBody.statusCode).toBe(422);

    const badExpiry = await mintShare(klass.id, server.authHeaders, { expiresAt: "tomorrow" });
    expect(badExpiry.statusCode).toBe(422);
  });
});

describe("share auth gates", () => {
  it("rejects missing credentials on every management route", async () => {
    server = await makeTestServer();
    const page = await createNode(pageBody("Gated"));
    expect((await mintShare(page.id, {})).statusCode).toBe(401);
    expect((await server.app.inject({ method: "GET", url: "/api/shares" })).statusCode).toBe(401);
    expect(
      (await server.app.inject({ method: "DELETE", url: "/api/shares/whatever" })).statusCode,
    ).toBe(401);
  });

  it("rejects strangers and plain members; admin sessions and the operator key pass", async () => {
    server = await makeTestServer();
    const page = await createNode(pageBody("Ownership"));
    const admin = await setupAdmin();
    const stranger = await mintUserSession("stranger@example.com", null);
    const member = await mintUserSession("member@example.com", "member");
    const owner = await mintUserSession("owner@example.com", "owner");

    expect((await mintShare(page.id, { authorization: `Bearer ${stranger}` })).statusCode).toBe(403);
    expect((await mintShare(page.id, { authorization: `Bearer ${member}` })).statusCode).toBe(403);
    expect((await mintShare(page.id, { authorization: `Bearer ${owner}` })).statusCode).toBe(201);
    expect((await mintShare(page.id, { authorization: `Bearer ${admin}` })).statusCode).toBe(201);
    expect((await mintShare(page.id, server.authHeaders)).statusCode).toBe(201);
  });
});

describe("the public share view", () => {
  it("renders the page title and its block tree as a static HTML document", async () => {
    server = await makeTestServer();
    const page = await createNode(pageBody("Quarterly <plan>"));
    await createNode({
      parentId: page.id,
      presentAsMain: false,
      contentAst: [
        { type: "text", text: "Ship the " },
        { type: "text", text: "shares", marks: ["bold"] },
        { type: "text", text: " slice" },
      ],
    });
    await createNode({
      parentId: page.id,
      presentAsMain: false,
      contentAst: [{ type: "text", text: "Nested child" }],
    });

    const minted = await mintShare(page.id, server.authHeaders);
    const urlPath = minted.json().share.urlPath as string;

    const view = await server.app.inject({ method: "GET", url: urlPath });
    expect(view.statusCode).toBe(200);
    expect(view.headers["content-type"]).toContain("text/html");
    const body = view.body;
    // The title and the block tree are present…
    expect(body).toContain("Quarterly &lt;plan&gt;"); // escaped, never raw
    expect(body).toContain("Ship the");
    expect(body).toContain("<strong>shares</strong>");
    expect(body).toContain("Nested child");
    expect(body).toContain("outline-list");
    // …with NO app and NO write surface: no script, no forms, no mutation UI.
    expect(body).not.toContain("<script");
    expect(body).not.toContain("<form");
    expect(body).toContain("<!DOCTYPE html>");
    // Privacy-sane headers.
    expect(view.headers["cache-control"]).toBe("no-store");
    expect(view.headers["x-content-type-options"]).toBe("nosniff");
    expect(view.headers["referrer-policy"]).toBe("no-referrer");
    expect(view.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  it("is GET-only: other methods hit the 404 wall", async () => {
    server = await makeTestServer();
    const page = await createNode(pageBody("Read only"));
    const minted = await mintShare(page.id, server.authHeaders);
    const urlPath = minted.json().share.urlPath as string;
    expect((await server.app.inject({ method: "POST", url: urlPath, payload: {} })).statusCode).toBe(404);
    expect((await server.app.inject({ method: "DELETE", url: urlPath })).statusCode).toBe(404);
    expect((await server.app.inject({ method: "PATCH", url: urlPath, payload: {} })).statusCode).toBe(404);
  });

  it("answers the same indistinguishable 404 for unknown, revoked, and expired tokens", async () => {
    server = await makeTestServer();
    const page = await createNode(pageBody("Vanishing"));
    const minted = await mintShare(page.id, server.authHeaders);
    const live = minted.json().share.urlPath as string;

    const unknown = await server.app.inject({ method: "GET", url: "/s/nonexistent-token-0000000000000000" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("not_found");

    await server.ctx.shares.revoke(minted.json().share.token as string);
    const revoked = await server.app.inject({ method: "GET", url: live });
    expect(revoked.statusCode).toBe(404);
    expect(revoked.json().error.code).toBe("not_found");

    const expiredRow = server.ctx.shares.create({
      workspaceId: server.ctx.defaultWorkspace,
      nodeId: page.id,
      createdBy: null,
      expiresAt: Date.now() - 1000,
    });
    const expired = await server.app.inject({ method: "GET", url: `/s/${expiredRow.token}` });
    expect(expired.statusCode).toBe(404);
    expect(expired.json().error.code).toBe("not_found");
  });

  it("dies with the page: trashing the node 404s its share", async () => {
    server = await makeTestServer();
    const page = await createNode(pageBody("Doomed"));
    const minted = await mintShare(page.id, server.authHeaders);
    const urlPath = minted.json().share.urlPath as string;

    const trashed = await server.app.inject({
      method: "DELETE",
      url: `/api/objects/${page.id}`,
      headers: server.authHeaders,
    });
    expect(trashed.statusCode).toBe(200);
    const view = await server.app.inject({ method: "GET", url: urlPath });
    expect(view.statusCode).toBe(404);
  });

  it("needs no credentials and rides the global limiter like any public route", async () => {
    server = await makeTestServer();
    const page = await createNode(pageBody("Open"));
    const minted = await mintShare(page.id, server.authHeaders);
    const view = await server.app.inject({ method: "GET", url: minted.json().share.urlPath });
    expect(view.statusCode).toBe(200);
  });
});
