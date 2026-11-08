/**
 * POST /api/capture/web-page — auth classes, validation, envelope stamping,
 * read-later inbox, idempotency, E2EE rejection, feature gating.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { InjectOptions } from "fastify";

import { dayNodeId, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

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

describe("property stamping (task 5)", () => {
  it("stamps url + accessDate and a note child block", async () => {
    server = await makeTestServer();
    const res = await capture(server, { ...CAPTURE_BODY, note: "read this" }, server.authHeaders);
    expect(res.statusCode).toBe(201);
    const { objectId } = res.json();
    const store = server.ctx.workspaces.storeFor(server.ctx.defaultWorkspace);
    // The derived store JSON-encodes property values, so parse the row.
    const urlRow = store.database
      .prepare("SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ?")
      .get(objectId, SYSTEM_PROPERTY_UUIDS.url) as { value: string } | undefined;
    expect(urlRow && JSON.parse(urlRow.value)).toBe(CAPTURE_URL);
    // accessDate is a datetime schema: the value is a day-node reference at
    // day precision (the deterministic date-chain id for today).
    const accessRow = store.database
      .prepare("SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ?")
      .get(objectId, SYSTEM_PROPERTY_UUIDS.accessDate) as { value: string } | undefined;
    const today = new Date().toISOString().slice(0, 10);
    expect(accessRow && JSON.parse(accessRow.value)).toEqual({ nodeId: dayNodeId(today) });
    // The note becomes an embedded child block (node.content is contentAst JSON).
    const child = store.database
      .prepare("SELECT id, content FROM node WHERE parent_id = ? AND is_embedded = 1")
      .get(objectId) as { id: string; content: string } | undefined;
    expect(child && JSON.parse(child.content)).toEqual([{ type: "text", text: "read this" }]);
  });

  it("envelope sequence rides the one write path with client capture", async () => {
    server = await makeTestServer();
    await capture(server, CAPTURE_BODY, server.authHeaders);
    const ops = await server.app.inject({ method: "GET", url: "/api/operations?limit=10000", headers: server.authHeaders });
    // The system seed rides the same relay log (client "seed"), so pin the
    // capture-stamped envelopes: the date-chain ensures, the object.create,
    // then the property.set pair, in order, under the capture client and the
    // server actor, with the url + accessDate property keys.
    const envs = (ops.json().operations as Array<{
      opType: string;
      client: string;
      actorId: string;
      payload: { propertySchemaId?: string };
    }>).filter((o) => o.client === "capture");
    expect(envs.map((o) => o.opType)).toEqual([
      "object.create",
      "object.create",
      "object.create",
      "object.create",
      "property.set",
      "property.set",
    ]);
    expect(
      envs
        .filter((o) => o.opType === "property.set")
        .map((o) => o.payload.propertySchemaId),
    ).toEqual([SYSTEM_PROPERTY_UUIDS.url, SYSTEM_PROPERTY_UUIDS.accessDate]);
    expect(envs.every((e) => e.client === "capture")).toBe(true);
    expect(envs.every((e) => e.actorId === server!.ctx.actorId)).toBe(true);
  });
});
