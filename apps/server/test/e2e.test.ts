/**
 * End-to-end over a real listening socket: boot on an ephemeral port,
 * CLI-style fetch handshake (API key), batch an object.create through
 * /api/relay/v2, read it back through /api/v1/objects/:id.
 */

import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { closeTestServer, makeTestServer, testEnvelope, type TestServer } from "./helpers";

let server: TestServer | null = null;
afterEach(async () => {
  if (server !== null) {
    await closeTestServer(server);
    server = null;
  }
});

describe("end-to-end (listening socket + fetch)", () => {
  it("handshake → batch → read", async () => {
    server = await makeTestServer();
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = server.app.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    // CLI-style handshake: API key over fetch.
    const handshake = await fetch(`${base}/api/relay/v2/stats?workspaceId=${server.workspaceId}`, {
      headers: { "x-api-key": server.apiKey },
    });
    expect(handshake.status).toBe(200);

    const envelope = testEnvelope({
      workspaceId: server.ctx.defaultWorkspace,
      opType: "object.create",
      payload: { objectId: crypto.randomUUID(), nodeType: "page", name: "E2E page" },
    });
    const batch = await fetch(`${base}/api/relay/v2/batch`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": server.apiKey },
      body: JSON.stringify({ envelopes: [envelope] }),
    });
    expect(batch.status).toBe(200);
    expect(((await batch.json()) as { savedCount: number }).savedCount).toBe(1);

    const objectId = (envelope.payload as { objectId: string }).objectId;
    const fetched = await fetch(`${base}/api/v1/objects/${objectId}`, {
      headers: { "x-api-key": server.apiKey },
    });
    expect(fetched.status).toBe(200);
    const body = (await fetched.json()) as { object: { id: string; name: string; nodeType: string } };
    expect(body.object).toMatchObject({ id: objectId, name: "E2E page", nodeType: "page" });
  });
});
