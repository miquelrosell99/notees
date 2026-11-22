/**
 * Confidential-share tests — the password-sealed READ half of the parked
 * §3.3 (proposal): a subtree render sealed client-side with a
 * password-derived key, addressed to an email, readable by an account
 * matching that email WITHOUT any membership on the source workspace.
 *
 *  - POST /api/confidential-shares mints (owner/admin gate, node gates,
 *    the artifact cap);
 *  - GET /api/confidential-shares/inbox addresses rows by email
 *    (case-insensitive), carries the granter + the plaintext display name,
 *    and empties on revoke;
 *  - GET /api/confidential-shares/:id/artifact returns the CIPHERTEXT +
 *    salt/kdf only to the addressee's session (strangers, other accounts,
 *    the operator key, and revoked rows all 404 the SAME way);
 *  - DELETE revokes immediately.
 */

import { afterEach, describe, expect, it } from "vitest";

import { hashPassword } from "../src/auth.js";
import { closeTestServer, makeTestServer, pagePayload, testEnvelope, type TestServer } from "./helpers";

let server: TestServer | null = null;
afterEach(async () => {
  if (server !== null) {
    await closeTestServer(server);
    server = null;
  }
});

async function createNode(title: string): Promise<string> {
  await server!.ctx.ensureSeeded(server!.ctx.defaultWorkspace);
  const id = crypto.randomUUID();
  const { objectId: _dropped, ...rest } = pagePayload(title);
  await server!.app.inject({
    method: "POST",
    url: "/api/relay/v2/batch",
    headers: { "content-type": "application/json", ...server!.authHeaders },
    payload: {
      envelopes: [
        testEnvelope({
          workspaceId: server!.ctx.defaultWorkspace,
          opType: "object.create",
          payload: { objectId: id, ...rest },
        }),
      ],
    },
  });
  return id;
}

async function mintUser(email: string): Promise<{ id: string; token: string }> {
  const user = server!.ctx.auth.createUser({
    email,
    passwordHash: await hashPassword(`${email}-password`),
  });
  return { id: user.id, token: server!.ctx.auth.createSession(user.id).token };
}

const asUser = (token: string) => ({ authorization: `Bearer ${token}` });

const KDF = { algorithm: "scrypt", N: 16384, r: 8, p: 1 } as const;

function publishBody(nodeId: string, email = "reader@example.com") {
  return {
    nodeId,
    recipientEmail: email,
    displayName: "Proyecto secreto",
    artifact: "YVVJrYWdlLWNpcGhlcnRleA", // opaque b64u for these tests
    salt: "c2FsdA",
    kdf: KDF,
  };
}

describe("confidential shares", () => {
  it("mints, lists in the addressee's inbox with the display name, serves the artifact to the addressee only, and revokes", async () => {
    server = await makeTestServer();
    const nodeId = await createNode("Secret project");
    const reader = await mintUser("reader@example.com");

    const minted = await server.app.inject({
      method: "POST",
      url: "/api/confidential-shares",
      headers: { "content-type": "application/json", ...server.authHeaders },
      payload: publishBody(nodeId),
    });
    expect(minted.statusCode).toBe(201);
    const shareId = minted.json().share.id as string;

    // The addressee's inbox carries the plaintext label + granter identity.
    const inbox = await server.app.inject({
      method: "GET",
      url: "/api/confidential-shares/inbox",
      headers: asUser(reader.token),
    });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json().shares).toHaveLength(1);
    expect(inbox.json().shares[0]).toMatchObject({
      id: shareId,
      nodeId,
      displayName: "Proyecto secreto",
    });

    // The artifact route: ciphertext + salt + kdf, for the addressee.
    const artifact = await server.app.inject({
      method: "GET",
      url: `/api/confidential-shares/${shareId}/artifact`,
      headers: asUser(reader.token),
    });
    expect(artifact.statusCode).toBe(200);
    expect(artifact.json()).toEqual({
      artifact: "YVVJrYWdlLWNpcGhlcnRleA",
      salt: "c2FsdA",
      kdf: KDF,
    });

    // Revocation empties the inbox and 404s the artifact read.
    const revoked = await server.app.inject({
      method: "DELETE",
      url: `/api/confidential-shares/${shareId}`,
      headers: server.authHeaders,
    });
    expect(revoked.json()).toEqual({ ok: true });
    const inboxAfter = await server.app.inject({
      method: "GET",
      url: "/api/confidential-shares/inbox",
      headers: asUser(reader.token),
    });
    expect(inboxAfter.json().shares).toHaveLength(0);
    expect(
      (
        await server.app.inject({
          method: "GET",
          url: `/api/confidential-shares/${shareId}/artifact`,
          headers: asUser(reader.token),
        })
      ).statusCode,
    ).toBe(404);
    // A second revoke 404s (no such LIVE share).
    expect(
      (await server.app.inject({ method: "DELETE", url: `/api/confidential-shares/${shareId}`, headers: server.authHeaders })).statusCode,
    ).toBe(404);
  });

  it("the artifact route is addressee-only: strangers, other accounts, and the operator key get the same 404", async () => {
    server = await makeTestServer();
    const nodeId = await createNode("Addressed");
    const reader = await mintUser("reader@example.com");
    const other = await mintUser("other@example.com");
    const minted = await server.app.inject({
      method: "POST",
      url: "/api/confidential-shares",
      headers: { "content-type": "application/json", ...server.authHeaders },
      payload: publishBody(nodeId),
    });
    const shareId = minted.json().share.id as string;

    // A different account: the same 404 (the row's existence is not revealed).
    expect(
      (
        await server.app.inject({
          method: "GET",
          url: `/api/confidential-shares/${shareId}/artifact`,
          headers: asUser(other.token),
        })
      ).statusCode,
    ).toBe(404);
    // The operator key is authenticated but not an addressee-capable principal.
    expect(
      (
        await server.app.inject({
          method: "GET",
          url: `/api/confidential-shares/${shareId}/artifact`,
          headers: server.authHeaders,
        })
      ).statusCode,
    ).toBe(403);
    // A bogus session is just unauthenticated.
    expect(
      (
        await server.app.inject({
          method: "GET",
          url: `/api/confidential-shares/${shareId}/artifact`,
          headers: { authorization: "Bearer bogus" },
        })
      ).statusCode,
    ).toBe(401);
    // Unknown ids 404 too.
    expect(
      (
        await server.app.inject({
          method: "GET",
          url: `/api/confidential-shares/${crypto.randomUUID()}/artifact`,
          headers: asUser(reader.token),
        })
      ).statusCode,
    ).toBe(404);
    // And the addressee with a DIFFERENT-Case email still matches (NOCASE).
    const upper = await mintUser("READER2@EXAMPLE.COM");
    await server.app.inject({
      method: "POST",
      url: "/api/confidential-shares",
      headers: { "content-type": "application/json", ...server.authHeaders },
      payload: publishBody(nodeId, "reader2@example.com"),
    });
    const upperInbox = await server.app.inject({
      method: "GET",
      url: "/api/confidential-shares/inbox",
      headers: asUser(upper.token),
    });
    expect(upperInbox.json().shares).toHaveLength(1);
  });

  it("gates and validation: anonymous 401, plain accounts 403 on mint, unknown node 404, class node 422, over-cap artifact 422", async () => {
    server = await makeTestServer();
    const nodeId = await createNode("Gates");
    const outsider = await mintUser("outsider@example.com");
    const base = publishBody(nodeId);

    expect(
      (
        await server.app.inject({
          method: "POST",
          url: "/api/confidential-shares",
          headers: { "content-type": "application/json" },
          payload: base,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await server.app.inject({
          method: "POST",
          url: "/api/confidential-shares",
          headers: { "content-type": "application/json", ...asUser(outsider.token) },
          payload: base,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await server.app.inject({
          method: "POST",
          url: "/api/confidential-shares",
          headers: { "content-type": "application/json", ...server.authHeaders },
          payload: publishBody(crypto.randomUUID()),
        })
      ).statusCode,
    ).toBe(404);
    const classId = crypto.randomUUID();
    await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/batch",
      headers: { "content-type": "application/json", ...server.authHeaders },
      payload: {
        envelopes: [
          testEnvelope({
            workspaceId: server.ctx.defaultWorkspace,
            opType: "class.create",
            payload: { classId, contentAst: [{ type: "text", text: "Genre" }] },
          }),
        ],
      },
    });
    expect(
      (
        await server.app.inject({
          method: "POST",
          url: "/api/confidential-shares",
          headers: { "content-type": "application/json", ...server.authHeaders },
          payload: publishBody(classId),
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await server.app.inject({
          method: "POST",
          url: "/api/confidential-shares",
          headers: { "content-type": "application/json", ...server.authHeaders },
          payload: { ...base, artifact: "x".repeat(5 * 1024 * 1024 + 1) },
        })
      ).statusCode,
    ).toBe(422);
    // The inbox is session-only too.
    expect((await server.app.inject({ method: "GET", url: "/api/confidential-shares/inbox" })).statusCode).toBe(401);
  });
});
