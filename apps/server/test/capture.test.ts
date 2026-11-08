/**
 * POST /api/capture/web-page — auth classes, validation, envelope stamping,
 * read-later inbox, idempotency, E2EE rejection, feature gating.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { InjectOptions } from "fastify";

import { closeTestServer, makeTestServer, type TestServer } from "./helpers";

const CAPTURE_URL = "https://example.com/article";
const CAPTURE_BODY = { url: CAPTURE_URL, title: "Example article", mode: "source" };

let server: TestServer | null = null;
afterEach(async () => {
  if (server !== null) { await closeTestServer(server); server = null; }
});

async function sessionHeaders(s: TestServer): Promise<Record<string, string>> {
  await s.app.inject({ method: "POST", url: "/api/setup", payload: { email: "admin@example.com", password: "admin-password-1" } });
  const login = await s.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "admin-password-1" } });
  return { authorization: `Bearer ${login.json().token}` };
}

async function scopedKey(s: TestServer, scopes: string[]): Promise<string> {
  const created = await s.app.inject({
    method: "POST",
    url: "/api/api-keys",
    headers: await sessionHeaders(s),
    payload: { name: "connector", scopes },
  });
  expect(created.statusCode).toBe(201);
  return created.json().token;
}

function capture(s: TestServer, body: unknown, headers: Record<string, string>) {
  return s.app.inject({ method: "POST", url: "/api/capture/web-page", headers: { "content-type": "application/json", ...headers }, payload: body } as InjectOptions);
}

describe("POST /api/capture/web-page — skeleton (task 4)", () => {
  it("rejects unauthenticated calls with 401", async () => {
    server = await makeTestServer();
    const res = await capture(server, CAPTURE_BODY, {});
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthenticated");
  });

  it("rejects a scoped key without capture.write (403 scope_denied)", async () => {
    server = await makeTestServer();
    const key = await scopedKey(server, ["objects.read"]);
    const res = await capture(server, CAPTURE_BODY, { "x-api-key": key });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("scope_denied");
  });

  it("accepts a capture.write-scoped key and a session", async () => {
    server = await makeTestServer();
    const key = await scopedKey(server, ["capture.write"]);
    const viaKey = await capture(server, CAPTURE_BODY, { "x-api-key": key });
    expect(viaKey.statusCode).toBe(201);
    expect(viaKey.json().objectId).toMatch(/^[0-9a-f-]{36}$/);
    const viaSession = await capture(server, { ...CAPTURE_BODY, url: "https://example.com/other" }, await sessionHeaders(server));
    expect(viaSession.statusCode).toBe(201);
  });

  it("rejects malformed bodies with 422 and persists nothing", async () => {
    server = await makeTestServer();
    const bad = await capture(server, { url: "not a url", title: "T", mode: "source" }, server.authHeaders);
    expect(bad.statusCode).toBe(422);
    const oversized = await capture(server, { url: `https://example.com/${"a".repeat(2100)}`, title: "T", mode: "source" }, server.authHeaders);
    expect(oversized.statusCode).toBe(422);
    const ftp = await capture(server, { url: "ftp://example.com/x", title: "T", mode: "readlater" }, server.authHeaders);
    expect(ftp.statusCode).toBe(422);
    const before = server.ctx.relay.envelopeCount(server.ctx.defaultWorkspace);
    expect(before).toBe(0);
  });
});
