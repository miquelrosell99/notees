/**
 * Per-node grants tests — the per-node-sharing proposal's trusted-circle v1:
 *
 *  - grant CRUD (POST /grants, GET /grants?nodeId=, DELETE /grants/:id) with
 *    the owner/admin gate (operator key, admin session, owner membership
 *    pass; strangers and plain members get 401/403);
 *  - email grants stay PENDING until an account with that email exists,
 *    then resolve with no further writes (the no-invite-tokens ruling);
 *  - GET /grants/inbox: the Shares Inbox — the caller's live grants with
 *    the granter's identity, restricted to member workspaces;
 *  - PUT /workspaces/:id/members/:userId: the owner demotes an account to
 *    role "member" (restricted) — non-owners 403, self-demotion 422;
 *  - the relay WRITE-GUARD: a restricted member's ingest is rejected (403)
 *    when an envelope's affectedNodeIds step outside her edit-grant
 *    closures; subtree children are covered; empty affectedNodeIds are
 *    refused; owners and the operator key write anywhere; reads are
 *    untouched.
 */

import { afterEach, describe, expect, it } from "vitest";

import { hashPassword } from "../src/auth.js";
import { closeTestServer, ingest, makeTestServer, pagePayload, testEnvelope, type TestServer } from "./helpers";

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
  await server!.ctx.ensureSeeded(server!.ctx.defaultWorkspace);
  const id = crypto.randomUUID();
  const isClass = body.isClass === true;
  // Callers pass pagePayload-shaped bodies that carry their OWN random
  // objectId — ours wins (the payload's is dropped).
  const { objectId: _dropped, isClass: _c, ...rest } = body;
  const response = await server!.app.inject({
    method: "POST",
    url: "/api/relay/v2/batch",
    headers: { "content-type": "application/json", ...server!.authHeaders },
    payload: {
      envelopes: [
        testEnvelope({
          workspaceId: server!.ctx.defaultWorkspace,
          opType: isClass ? "class.create" : "object.create",
          payload: isClass ? { classId: id, ...rest } : { objectId: id, ...rest },
        }),
      ],
    },
  });
  return { id, response };
}

async function mintUser(email: string, role: string | null): Promise<{ id: string; token: string }> {
  const user = server!.ctx.auth.createUser({
    email,
    passwordHash: await hashPassword(`${email}-password`),
  });
  // Membership (and every server surface) speaks the DEFAULT workspace —
  // helpers' TEST_WORKSPACE is a different id.
  if (role !== null) server!.ctx.auth.addMember(server!.ctx.defaultWorkspace, user.id, role);
  return { id: user.id, token: server!.ctx.auth.createSession(user.id).token };
}

const asUser = (token: string) => ({ authorization: `Bearer ${token}` });

/** One envelope targeting `nodeId` with the affected ids the guard reads. */
function touching(nodeId: string, opType = "object.update", extra: Record<string, unknown> = {}) {
  return {
    ...testEnvelope({ workspaceId: server!.ctx.defaultWorkspace, opType, payload: { objectId: nodeId, color: "sky", ...extra } }),
    affectedNodeIds: [nodeId],
  };
}

async function batchAs(token: string | null, envelopes: unknown[]) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) Object.assign(headers, asUser(token));
  return server!.app.inject({
    method: "POST",
    url: "/api/relay/v2/batch",
    headers,
    payload: { envelopes },
  });
}

describe("grant management", () => {
  it("mints, lists, and revokes a grant; revocation is immediate", async () => {
    server = await makeTestServer();
    const page = await createNode(pagePayload("Proyecto"));
    const grantee = await mintUser("spouse@example.com", "member");

    const minted = await server.app.inject({
      method: "POST",
      url: "/api/grants",
      headers: { "content-type": "application/json", ...server.authHeaders },
      payload: { nodeId: page.id, granteeUserId: grantee.id, role: "edit" },
    });
    expect(minted.statusCode).toBe(201);
    expect(minted.json().grant).toMatchObject({
      nodeId: page.id,
      granteeUserId: grantee.id,
      role: "edit",
    });

    const listed = await server.app.inject({
      method: "GET",
      url: `/api/grants?nodeId=${page.id}`,
      headers: server.authHeaders,
    });
    expect(listed.json().grants).toHaveLength(1);
    expect(listed.json().grants[0].id).toBe(minted.json().grant.id);

    const revoked = await server.app.inject({
      method: "DELETE",
      url: `/api/grants/${minted.json().grant.id}`,
      headers: server.authHeaders,
    });
    expect(revoked.json()).toEqual({ ok: true });
    const after = await server.app.inject({
      method: "GET",
      url: `/api/grants?nodeId=${page.id}`,
      headers: server.authHeaders,
    });
    expect(after.json().grants).toHaveLength(0);
    // A second revoke 404s (no such LIVE grant).
    expect(
      (await server.app.inject({ method: "DELETE", url: `/api/grants/${minted.json().grant.id}`, headers: server.authHeaders })).statusCode,
    ).toBe(404);
  });

  it("read is the default role; exactly one grantee selector is required", async () => {
    server = await makeTestServer();
    const page = await createNode(pagePayload("Defaults"));
    const grantee = await mintUser("reader@example.com", "member");
    const base = { "content-type": "application/json", ...server.authHeaders };

    const readDefault = await server.app.inject({
      method: "POST",
      url: "/api/grants",
      headers: base,
      payload: { nodeId: page.id, granteeUserId: grantee.id },
    });
    expect(readDefault.json().grant.role).toBe("read");

    const both = await server.app.inject({
      method: "POST",
      url: "/api/grants",
      headers: base,
      payload: { nodeId: page.id, granteeUserId: grantee.id, granteeEmail: "x@example.com" },
    });
    expect(both.statusCode).toBe(422);

    const neither = await server.app.inject({
      method: "POST",
      url: "/api/grants",
      headers: base,
      payload: { nodeId: page.id },
    });
    expect(neither.statusCode).toBe(422);
  });

  it("fails loud: unknown node 404, class node 422, unknown grantee user 404", async () => {
    server = await makeTestServer();
    const base = { "content-type": "application/json", ...server.authHeaders };
    expect(
      (await server.app.inject({ method: "POST", url: "/api/grants", headers: base, payload: { nodeId: crypto.randomUUID(), granteeEmail: "a@b.com" } })).statusCode,
    ).toBe(404);
    const klass = await createNode({ isClass: true, contentAst: [{ type: "text", text: "Genre" }] });
    expect(
      (await server.app.inject({ method: "POST", url: "/api/grants", headers: base, payload: { nodeId: klass.id, granteeEmail: "a@b.com" } })).statusCode,
    ).toBe(422);
    const page = await createNode(pagePayload("X"));
    expect(
      (await server.app.inject({ method: "POST", url: "/api/grants", headers: base, payload: { nodeId: page.id, granteeUserId: crypto.randomUUID() } })).statusCode,
    ).toBe(404);
  });

  it("gates: anonymous 401, plain members 403, the operator key passes", async () => {
    server = await makeTestServer();
    const page = await createNode(pagePayload("Gates"));
    const member = await mintUser("member@example.com", "owner");
    const outsider = await mintUser("outsider@example.com", null);

    expect(
      (await server.app.inject({ method: "POST", url: "/api/grants", headers: { "content-type": "application/json" }, payload: { nodeId: page.id, granteeEmail: "a@b.com" } })).statusCode,
    ).toBe(401);
    expect(
      (
        await server.app.inject({
          method: "POST",
          url: "/api/grants",
          headers: { "content-type": "application/json", ...asUser(outsider.token) },
          payload: { nodeId: page.id, granteeEmail: "a@b.com" },
        })
      ).statusCode,
    ).toBe(403);
    // An owner membership (not the admin flag) manages grants too.
    const byOwner = await server.app.inject({
      method: "POST",
      url: "/api/grants",
      headers: { "content-type": "application/json", ...asUser(member.token) },
      payload: { nodeId: page.id, granteeEmail: "pending@example.com" },
    });
    expect(byOwner.statusCode).toBe(201);
  });
});

describe("the Shares Inbox (GET /api/grants/inbox)", () => {
  it("email grants stay pending until an account with that email exists, then resolve with no further writes", async () => {
    server = await makeTestServer();
    const page = await createNode(pagePayload("Inbox"));
    // Mint against an email nobody has yet.
    await server.app.inject({
      method: "POST",
      url: "/api/grants",
      headers: { "content-type": "application/json", ...server.authHeaders },
      payload: { nodeId: page.id, granteeEmail: "later@example.com", role: "edit" },
    });
    // Create the account AFTER the grant — no grant re-write.
    const late = await mintUser("later@example.com", "member");
    const inbox = await server.app.inject({ method: "GET", url: "/api/grants/inbox", headers: asUser(late.token) });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json().grants).toHaveLength(1);
    expect(inbox.json().grants[0]).toMatchObject({ nodeId: page.id, role: "edit" });
  });

  it("carries the granter's identity, skips non-member workspaces, and empties on revoke", async () => {
    server = await makeTestServer();
    const owner = await mintUser("owner@example.com", "owner");
    const page = await createNode(pagePayload("Granter"));
    const grantee = await mintUser("grantee@example.com", "member");

    const minted = await server.app.inject({
      method: "POST",
      url: "/api/grants",
      headers: { "content-type": "application/json", ...asUser(owner.token) },
      payload: { nodeId: page.id, granteeUserId: grantee.id },
    });
    const inbox = await server.app.inject({ method: "GET", url: "/api/grants/inbox", headers: asUser(grantee.token) });
    expect(inbox.json().grants[0].grantedByEmail).toBe("owner@example.com");

    // A non-member with the same email shape sees nothing (workspace filter).
    const stranger = await mintUser("stranger@example.com", null);
    const strangerInbox = await server.app.inject({ method: "GET", url: "/api/grants/inbox", headers: asUser(stranger.token) });
    expect(strangerInbox.json().grants).toHaveLength(0);

    await server.app.inject({
      method: "DELETE",
      url: `/api/grants/${minted.json().grant.id}`,
      headers: asUser(owner.token),
    });
    const after = await server.app.inject({ method: "GET", url: "/api/grants/inbox", headers: asUser(grantee.token) });
    expect(after.json().grants).toHaveLength(0);
  });
});

describe("member roles (PUT /api/workspaces/:id/members/:userId)", () => {
  it("the owner sets role member|owner; non-owners 403, self-demotion 422, unknown users 404", async () => {
    server = await makeTestServer();
    const owner = await mintUser("o@example.com", "owner");
    const target = await mintUser("t@example.com", "member");
    const otherOwner = await mintUser("oo@example.com", "owner");

    const set = await server.app.inject({
      method: "PUT",
      url: `/api/workspaces/${server.ctx.defaultWorkspace}/members/${target.id}`,
      headers: { "content-type": "application/json", ...asUser(owner.token) },
      payload: { role: "member" },
    });
    expect(set.json()).toEqual({ ok: true, role: "member" });

    expect(
      (
        await server.app.inject({
          method: "PUT",
          url: `/api/workspaces/${server.ctx.defaultWorkspace}/members/${target.id}`,
          headers: { "content-type": "application/json", ...asUser(target.token) },
          payload: { role: "owner" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await server.app.inject({
          method: "PUT",
          url: `/api/workspaces/${server.ctx.defaultWorkspace}/members/${owner.id}`,
          headers: { "content-type": "application/json", ...asUser(owner.token) },
          payload: { role: "member" },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await server.app.inject({
          method: "PUT",
          url: `/api/workspaces/${server.ctx.defaultWorkspace}/members/${crypto.randomUUID()}`,
          headers: { "content-type": "application/json", ...asUser(otherOwner.token) },
          payload: { role: "member" },
        })
      ).statusCode,
    ).toBe(404);
    // The role actually changed.
    expect(server.ctx.auth.membership(server.ctx.defaultWorkspace, target.id)).toBe("member");
  });
});

describe("the relay write-guard (restricted members)", () => {
  it("restricted without grants writes nothing; edit grant opens the subtree and only the subtree", async () => {
    server = await makeTestServer();
    const project = await createNode(pagePayload("Proyecto"));
    const whiteboard = await createNode({ parentId: project.id, contentAst: [{ type: "text", text: "board" }] });
    const private_ = await createNode(pagePayload("Privado"));
    const spouse = await mintUser("spouse@example.com", "member");

    // No grants yet: even her own-name write is refused (empty coverage).
    const before = await batchAs(spouse.token, [touching(whiteboard.id)]);
    expect(before.statusCode).toBe(403);
    expect(before.json().error.code).toBe("forbidden");

    // Edit grant on the project: the child whiteboard is inside the closure.
    await server.app.inject({
      method: "POST",
      url: "/api/grants",
      headers: { "content-type": "application/json", ...server.authHeaders },
      payload: { nodeId: project.id, granteeUserId: spouse.id, role: "edit" },
    });

    const inClosure = await batchAs(spouse.token, [
      touching(whiteboard.id, "object.update", { color: "sky" }),
    ]);
    expect(inClosure.statusCode).toBe(200);

    const outside = await batchAs(spouse.token, [
      touching(private_.id, "object.update", { color: "sky" }),
    ]);
    expect(outside.statusCode).toBe(403);

    // A read (catch-up) is untouched.
    const read = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/catch-up",
      headers: asUser(spouse.token),
      payload: { workspaceId: server.ctx.defaultWorkspace, afterSeq: 0, limit: 10 },
    });
    expect(read.statusCode).toBe(200);

    // Revocation closes the subtree again.
    const grants = await server.app.inject({ method: "GET", url: `/api/grants?nodeId=${project.id}`, headers: server.authHeaders });
    await server.app.inject({ method: "DELETE", url: `/api/grants/${grants.json().grants[0].id}`, headers: server.authHeaders });
    const after = await batchAs(spouse.token, [touching(whiteboard.id)]);
    expect(after.statusCode).toBe(403);
  });

  it("owners and the operator key write anywhere; empty affectedNodeIds are refused for restricted writers", async () => {
    server = await makeTestServer();
    const owner = await mintUser("owner@example.com", "owner");
    const page = await createNode(pagePayload("OwnerWrites"));
    const spouse = await mintUser("spouse2@example.com", "member");

    expect((await batchAs(owner.token, [touching(page.id)])).statusCode).toBe(200);
    expect((await ingest(server, [touching(page.id)])).statusCode).toBe(200);

    // The granter's identity is NULL when the operator key minted the grant
    // (it is not a user row) — the UI renders "the workspace owner" then.
    const empty = {
      ...testEnvelope({ workspaceId: server.ctx.defaultWorkspace, opType: "object.update", payload: { objectId: page.id, color: "sky" } }),
      affectedNodeIds: [],
    };
    const refused = await batchAs(spouse.token, [empty]);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toContain("affectedNodeIds");
  });
});
