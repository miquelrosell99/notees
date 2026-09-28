import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";

import { closeTestServer, makeTestServer, pagePayload, testEnvelope, type TestServer } from "./helpers";

let server: TestServer | null = null;
afterEach(async () => {
  if (server !== null) {
    await closeTestServer(server);
    server = null;
  }
});

interface FrameCollector {
  frames: Record<string, unknown>[];
  waitFor(predicate: (frame: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
}

function collect(ws: WebSocket): FrameCollector {
  const frames: Record<string, unknown>[] = [];
  const waiters: { predicate: (frame: Record<string, unknown>) => boolean; resolve: (frame: Record<string, unknown>) => void }[] = [];
  ws.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>;
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i]!.predicate(frame)) {
        waiters[i]!.resolve(frame);
        waiters.splice(i, 1);
      }
    }
  });
  return {
    frames,
    waitFor(predicate, timeoutMs = 3000) {
      const existing = frames.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for frame")), timeoutMs);
        waiters.push({
          predicate,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    },
  };
}

async function connect(workspaceId: string, token?: string): Promise<{ ws: WebSocket; collector: FrameCollector }> {
  await server!.app.ready();
  const query = token !== undefined ? `?token=${encodeURIComponent(token)}` : "";
  // Attach the collector in onInit so the hello frame cannot race it.
  let collector!: FrameCollector;
  const ws = await server!.app.injectWS(`/api/relay/v2/ws/${workspaceId}${query}`, {}, {
    onInit: (socket) => {
      collector = collect(socket as WebSocket);
    },
  });
  return { ws, collector };
}

describe("WS /ws/{workspaceId}", () => {
  it("greets with hello (framing version 2, restoreEpoch, latestSeq)", async () => {
    server = await makeTestServer();
    const { ws, collector } = await connect(server.workspaceId, server.apiKey);
    const hello = await collector.waitFor((frame) => frame.type === "hello");
    expect(hello).toMatchObject({ wsProtocolVersion: 2, restoreEpoch: 0, latestSeq: 0 });
    ws.terminate();
  });

  it("accepts a client batch frame, acks, and broadcasts ops with seqs", async () => {
    server = await makeTestServer();
    const { ws, collector } = await connect(server.workspaceId, server.apiKey);
    await collector.waitFor((frame) => frame.type === "hello");

    const env = testEnvelope({ opType: "object.create", payload: pagePayload("ws-page") });
    ws.send(JSON.stringify({ type: "batch", envelopes: [env] }));
    const ack = await collector.waitFor((frame) => frame.type === "ack");
    expect(ack).toMatchObject({ savedIds: [env.id] });

    const ops = await collector.waitFor((frame) => frame.type === "ops");
    expect(ops.wsProtocolVersion).toBe(2);
    expect((ops.seqs as Record<string, number>)[env.id]).toBe(1);
    expect((ops.envelopes as { id: string }[])[0]!.id).toBe(env.id);

    const stats = (
      await server.app.inject({
        method: "GET",
        url: `/api/relay/v2/stats?workspaceId=${server.workspaceId}`,
        headers: server.authHeaders,
      })
    ).json();
    expect(stats.envelopeCount).toBe(1);
    ws.terminate();
  });

  it("broadcasts ops to other subscribers", async () => {
    server = await makeTestServer();
    const a = await connect(server.workspaceId, server.apiKey);
    const b = await connect(server.workspaceId, server.apiKey);
    await a.collector.waitFor((frame) => frame.type === "hello");
    await b.collector.waitFor((frame) => frame.type === "hello");

    const env = testEnvelope({ opType: "object.create", payload: pagePayload("broadcast") });
    a.ws.send(JSON.stringify({ type: "batch", envelopes: [env] }));
    await b.collector.waitFor((frame) => frame.type === "ops" && frame.seqs !== undefined);
    a.ws.terminate();
    b.ws.terminate();
  });

  it("ignores unknown frame types", async () => {
    server = await makeTestServer();
    const { ws, collector } = await connect(server.workspaceId, server.apiKey);
    await collector.waitFor((frame) => frame.type === "hello");
    ws.send(JSON.stringify({ type: "wat", payload: 42 }));
    const env = testEnvelope({ opType: "object.create", payload: pagePayload("still-alive") });
    ws.send(JSON.stringify({ type: "batch", envelopes: [env] }));
    await collector.waitFor((frame) => frame.type === "ack");
    const errors = collector.frames.filter((frame) => frame.type === "error");
    expect(errors).toHaveLength(0);
    ws.terminate();
  });

  it("fails loud on a newer framing version", async () => {
    server = await makeTestServer();
    const { ws, collector } = await connect(server.workspaceId, server.apiKey);
    await collector.waitFor((frame) => frame.type === "hello");
    ws.send(JSON.stringify({ type: "hello", wsProtocolVersion: 3 }));
    const error = await collector.waitFor((frame) => frame.type === "error");
    expect(String(error.message)).toContain("wsProtocolVersion");
    await new Promise((resolve) => ws.on("close", resolve));
  });

  it("answers errors for invalid batch frames without crashing the socket", async () => {
    server = await makeTestServer();
    const { ws, collector } = await connect(server.workspaceId, server.apiKey);
    await collector.waitFor((frame) => frame.type === "hello");
    ws.send(JSON.stringify({ type: "batch", envelopes: [{ not: "an envelope" }] }));
    const error = await collector.waitFor((frame) => frame.type === "error");
    expect(String(error.message)).toContain("envelope");

    const env = testEnvelope({ opType: "object.create", payload: pagePayload("after-error") });
    ws.send(JSON.stringify({ type: "batch", envelopes: [env] }));
    await collector.waitFor((frame) => frame.type === "ack");
    ws.terminate();
  });

  it("rejects the socket without a valid token", async () => {
    server = await makeTestServer();
    await server.app.ready();
    await expect(connect(server.workspaceId, `nk_${"z".repeat(32)}`)).rejects.toThrow();
  });

  it("requires auth on the route (plain HTTP probe)", async () => {
    server = await makeTestServer();
    const res = await server.app.inject({
      method: "GET",
      url: `/api/relay/v2/ws/${server.workspaceId}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthenticated");
  });
});
