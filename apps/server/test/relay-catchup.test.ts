import { afterEach, describe, expect, it } from "vitest";

import { closeTestServer, ingest, makeTestServer, pagePayload, testEnvelope, type TestServer } from "./helpers";

let server: TestServer | null = null;
afterEach(async () => {
  if (server !== null) {
    await closeTestServer(server);
    server = null;
  }
});

async function catchUp(afterSeq: number, limit = 100) {
  const res = await server!.app.inject({
    method: "POST",
    url: "/api/relay/v2/catch-up",
    headers: { "content-type": "application/json", ...server!.authHeaders },
    payload: { workspaceId: server!.workspaceId, afterSeq, limit },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    envelopes: { id: string }[];
    nextAfterSeq: number | null;
    hasMore: boolean;
    restoreEpoch: number;
    totalRemaining: number;
  };
}

describe("POST /catch-up pagination contract", () => {
  it("pages a 5-envelope log with tail-covering nextAfterSeq", async () => {
    server = await makeTestServer();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const env = testEnvelope({ opType: "object.create", payload: pagePayload(`n${i}`) });
      ids.push(env.id);
      const res = await ingest(server, [env]);
      expect(res.statusCode).toBe(200);
    }

    const page1 = await catchUp(0, 2);
    expect(page1.envelopes.map((e) => e.id)).toEqual([ids[0], ids[1]]);
    expect(page1.hasMore).toBe(true);
    expect(page1.totalRemaining).toBe(5);
    expect(page1.nextAfterSeq).not.toBeNull();

    const page2 = await catchUp(page1.nextAfterSeq!, 2);
    expect(page2.envelopes.map((e) => e.id)).toEqual([ids[2], ids[3]]);
    expect(page2.hasMore).toBe(true);
    expect(page2.totalRemaining).toBe(3);

    const page3 = await catchUp(page2.nextAfterSeq!, 2);
    expect(page3.envelopes.map((e) => e.id)).toEqual([ids[4]]);
    expect(page3.hasMore).toBe(false);
    expect(page3.totalRemaining).toBe(1);
    // Final page still covers the tail: HTTP-only clients can advance past it.
    expect(page3.nextAfterSeq).not.toBeNull();
    expect(page3.nextAfterSeq!).toBeGreaterThan(page2.nextAfterSeq!);
  });

  it("limit is clamped into [1, 10000]", async () => {
    server = await makeTestServer();
    await ingest(server, [testEnvelope({ opType: "object.create", payload: pagePayload("one") })]);
    const clampedLow = await catchUp(0, 0);
    expect(clampedLow.envelopes).toHaveLength(1);
    const res = await server!.app.inject({
      method: "POST",
      url: "/api/relay/v2/catch-up",
      headers: { "content-type": "application/json", ...server!.authHeaders },
      payload: { workspaceId: server!.workspaceId, afterSeq: 0, limit: 999_999 },
    });
    expect(res.statusCode).toBe(200);
  });

  it("reports restoreEpoch and rejects bad input with the error envelope", async () => {
    server = await makeTestServer();
    const bad = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/catch-up",
      headers: { "content-type": "application/json", ...server.authHeaders },
      payload: { workspaceId: "not-a-uuid", afterSeq: 0, limit: 10 },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toMatchObject({ code: "validation_failed", status: 422 });

    const empty = await catchUp(0);
    expect(empty.restoreEpoch).toBe(0);
    expect(empty.envelopes).toHaveLength(0);
    expect(empty.nextAfterSeq).toBeNull();
    expect(empty.hasMore).toBe(false);
    expect(empty.totalRemaining).toBe(0);
  });
});
