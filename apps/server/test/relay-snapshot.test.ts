import { afterEach, describe, expect, it } from "vitest";

import { closeTestServer, ingest, makeTestServer, pagePayload, testEnvelope, type TestServer } from "./helpers";

let server: TestServer | null = null;
afterEach(async () => {
  if (server !== null) {
    await closeTestServer(server);
    server = null;
  }
});

const SNAPSHOT_BYTES = Buffer.from("notees-snapshot-bytes");

async function putSnapshot(physical: number, logical: number, bytes: Buffer = SNAPSHOT_BYTES) {
  return server!.app.inject({
    method: "PUT",
    url: `/api/relay/v2/snapshot/data?workspaceId=${server!.workspaceId}&physical=${physical}&logical=${logical}`,
    headers: { "content-type": "application/octet-stream", ...server!.authHeaders },
    payload: bytes,
  });
}

describe("snapshots", () => {
  it("GET /snapshot reports hasSnapshot:false when empty", async () => {
    server = await makeTestServer();
    const res = await server.app.inject({
      method: "GET",
      url: `/api/relay/v2/snapshot?workspaceId=${server.workspaceId}`,
      headers: server.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      snapshotId: "",
      hlc: { physical: 0, logical: 0 },
      hasSnapshot: false,
      restoreEpoch: 0,
      upToSeq: null,
    });
  });

  it("GET /snapshot/data is 404 when absent", async () => {
    server = await makeTestServer();
    const res = await server.app.inject({
      method: "GET",
      url: `/api/relay/v2/snapshot/data?workspaceId=${server.workspaceId}`,
      headers: server.authHeaders,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: "not_found", status: 404 });
  });

  it("PUT then GET round-trips the blob with metadata", async () => {
    server = await makeTestServer();
    await ingest(server, [testEnvelope({ opType: "object.create", payload: pagePayload("s") })]);
    const put = await putSnapshot(100, 2);
    expect(put.statusCode).toBe(201);
    const putBody = put.json();
    expect(putBody.upToSeq).toBe(1);

    const meta = await server.app.inject({
      method: "GET",
      url: `/api/relay/v2/snapshot?workspaceId=${server.workspaceId}`,
      headers: server.authHeaders,
    });
    expect(meta.json()).toMatchObject({
      hasSnapshot: true,
      upToSeq: 1,
      restoreEpoch: 0,
      hlc: { physical: 100, logical: 2 },
    });
    expect(meta.json().snapshotId).toBe(putBody.snapshotId);

    const data = await server.app.inject({
      method: "GET",
      url: `/api/relay/v2/snapshot/data?workspaceId=${server.workspaceId}`,
      headers: server.authHeaders,
    });
    expect(data.statusCode).toBe(200);
    expect(data.headers["content-type"]).toBe("application/octet-stream");
    expect(Buffer.from(data.rawPayload).equals(SNAPSHOT_BYTES)).toBe(true);
  });
});

describe("POST /compact", () => {
  it("prune:true without dataBase64 is rejected", async () => {
    server = await makeTestServer();
    const res = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/compact",
      headers: { "content-type": "application/json", ...server.authHeaders },
      payload: {
        workspaceId: server.workspaceId,
        upToHlc: { physical: 999_999_999_999, logical: 0 },
        prune: true,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("validation_failed");
  });

  it("snapshots covered state and prunes the log with segment bookkeeping", async () => {
    server = await makeTestServer();
    for (let i = 0; i < 3; i += 1) {
      await ingest(server, [testEnvelope({ opType: "object.create", payload: pagePayload(`c${i}`) })]);
    }
    const res = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/compact",
      headers: { "content-type": "application/json", ...server.authHeaders },
      payload: {
        workspaceId: server.workspaceId,
        upToHlc: { physical: 9_999_999_999_999, logical: 0 },
        prune: true,
        dataBase64: SNAPSHOT_BYTES.toString("base64"),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().operationCount).toBe(3);

    const stats = (
      await server.app.inject({
        method: "GET",
        url: `/api/relay/v2/stats?workspaceId=${server.workspaceId}`,
        headers: server.authHeaders,
      })
    ).json();
    expect(stats.envelopeCount).toBe(0);
    expect(stats.compactedOperationCount).toBe(3);
    expect(stats.snapshotCount).toBe(1);
    expect(stats.latestSnapshotHlc).toEqual({ physical: 9_999_999_999_999, logical: 0 });

    const catchUp = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/catch-up",
      headers: { "content-type": "application/json", ...server.authHeaders },
      payload: { workspaceId: server.workspaceId, afterSeq: 0, limit: 100 },
    });
    expect(catchUp.json().envelopes).toHaveLength(0);

    const data = await server.app.inject({
      method: "GET",
      url: `/api/relay/v2/snapshot/data?workspaceId=${server.workspaceId}`,
      headers: server.authHeaders,
    });
    expect(data.statusCode).toBe(200);
  });

  it("prune:false keeps the log", async () => {
    server = await makeTestServer();
    await ingest(server, [testEnvelope({ opType: "object.create", payload: pagePayload("keep") })]);
    const res = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/compact",
      headers: { "content-type": "application/json", ...server.authHeaders },
      payload: {
        workspaceId: server.workspaceId,
        upToHlc: { physical: 9_999_999_999_999, logical: 0 },
        prune: false,
        dataBase64: SNAPSHOT_BYTES.toString("base64"),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().operationCount).toBe(1);
    const stats = (
      await server.app.inject({
        method: "GET",
        url: `/api/relay/v2/stats?workspaceId=${server.workspaceId}`,
        headers: server.authHeaders,
      })
    ).json();
    expect(stats.envelopeCount).toBe(1);
  });
});

describe("GET /stats", () => {
  it("reports the WIRE shape on an empty workspace", async () => {
    server = await makeTestServer();
    const res = await server.app.inject({
      method: "GET",
      url: `/api/relay/v2/stats?workspaceId=${server.workspaceId}`,
      headers: server.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      envelopeCount: 0,
      snapshotCount: 0,
      compactedOperationCount: 0,
      maxHlc: { physical: 0, logical: 0 },
      restoreEpoch: 0,
      latestSnapshotHlc: null,
    });
  });

  it("tracks envelopeCount and maxHlc after ingest", async () => {
    server = await makeTestServer();
    await ingest(server, [testEnvelope({ opType: "object.create", payload: pagePayload("hlc") })]);
    const res = await server.app.inject({
      method: "GET",
      url: `/api/relay/v2/stats?workspaceId=${server.workspaceId}`,
      headers: server.authHeaders,
    });
    const body = res.json();
    expect(body.envelopeCount).toBe(1);
    expect(body.maxHlc.physical).toBeGreaterThan(0);
  });
});
