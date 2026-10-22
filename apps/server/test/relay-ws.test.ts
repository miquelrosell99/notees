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

interface ConnectOptions {
  /** Credential headers for the upgrade (native-client path). */
  headers?: Record<string, string>;
  /** Admission ticket query param (browser path). */
  ticket?: string;
  /** Raw query string for negative tests (e.g. a retired ?token= attempt). */
  query?: string;
}

async function connect(workspaceId: string, options: ConnectOptions = {}): Promise<{ ws: WebSocket; collector: FrameCollector }> {
  await server!.app.ready();
  const query =
    options.query !== undefined
      ? options.query
      : options.ticket !== undefined
        ? `?ticket=${encodeURIComponent(options.ticket)}`
        : "";
  // Attach the collector in onInit so the hello frame cannot race it.
  let collector!: FrameCollector;
  const ws = await server!.app.injectWS(
    `/api/relay/v2/ws/${workspaceId}${query}`,
    { headers: options.headers ?? server!.authHeaders },
    {
      onInit: (socket) => {
        collector = collect(socket as WebSocket);
      },
    },
  );
  return { ws, collector };
}

/** Mint an admission ticket through the real HTTP route (browser path). */
async function mintTicket(workspaceId: string, headers: Record<string, string> = server!.authHeaders): Promise<string> {
  const res = await server!.app.inject({
    method: "POST",
    url: "/api/relay/v2/tickets",
    headers: { "content-type": "application/json", ...headers },
    payload: { workspaceId },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { ticket: string; expiresAt: number };
  expect(typeof body.ticket).toBe("string");
  expect(body.ticket).toMatch(/^ntk_/);
  expect(body.expiresAt).toBeGreaterThan(Date.now());
  return body.ticket;
}

describe("WS /ws/{workspaceId}", () => {
  it("greets with hello (framing version 2, restoreEpoch, latestSeq)", async () => {
    server = await makeTestServer();
    const { ws, collector } = await connect(server.workspaceId);
    const hello = await collector.waitFor((frame) => frame.type === "hello");
    expect(hello).toMatchObject({ wsProtocolVersion: 2, restoreEpoch: 0, latestSeq: 0 });
    ws.terminate();
  });

  it("accepts a client batch frame, acks, and broadcasts ops with seqs", async () => {
    server = await makeTestServer();
    const { ws, collector } = await connect(server.workspaceId);
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
    const a = await connect(server.workspaceId);
    const b = await connect(server.workspaceId);
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
    const { ws, collector } = await connect(server.workspaceId);
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
    const { ws, collector } = await connect(server.workspaceId);
    await collector.waitFor((frame) => frame.type === "hello");
    ws.send(JSON.stringify({ type: "hello", wsProtocolVersion: 3 }));
    const error = await collector.waitFor((frame) => frame.type === "error");
    expect(String(error.message)).toContain("wsProtocolVersion");
    await new Promise((resolve) => ws.on("close", resolve));
  });

  it("answers errors for invalid batch frames without crashing the socket", async () => {
    server = await makeTestServer();
    const { ws, collector } = await connect(server.workspaceId);
    await collector.waitFor((frame) => frame.type === "hello");
    ws.send(JSON.stringify({ type: "batch", envelopes: [{ not: "an envelope" }] }));
    const error = await collector.waitFor((frame) => frame.type === "error");
    expect(String(error.message)).toContain("envelope");

    const env = testEnvelope({ opType: "object.create", payload: pagePayload("after-error") });
    ws.send(JSON.stringify({ type: "batch", envelopes: [env] }));
    await collector.waitFor((frame) => frame.type === "ack");
    ws.terminate();
  });

  it("rejects the socket with an invalid API key header", async () => {
    server = await makeTestServer();
    await expect(
      connect(server.workspaceId, { headers: { "x-api-key": `nk_${"z".repeat(32)}` } }),
    ).rejects.toThrow();
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

describe("WS admission tickets (POST /tickets + ?ticket=)", () => {
  it("admits a socket with a freshly minted ticket and serves the hello frame", async () => {
    server = await makeTestServer();
    const ticket = await mintTicket(server.workspaceId);
    const { ws, collector } = await connect(server.workspaceId, { ticket, headers: {} });
    const hello = await collector.waitFor((frame) => frame.type === "hello");
    expect(hello).toMatchObject({ wsProtocolVersion: 2 });
    ws.terminate();
  });

  it("accepts the credential as an Authorization: Bearer header (native clients)", async () => {
    server = await makeTestServer();
    const { ws, collector } = await connect(server.workspaceId, {
      headers: { authorization: `Bearer ${server.apiKey}` },
    });
    const hello = await collector.waitFor((frame) => frame.type === "hello");
    expect(hello).toMatchObject({ wsProtocolVersion: 2 });
    ws.terminate();
  });

  it("tickets are single-use: a second connection with the same ticket is refused", async () => {
    server = await makeTestServer();
    const ticket = await mintTicket(server.workspaceId);
    const first = await connect(server.workspaceId, { ticket, headers: {} });
    await first.collector.waitFor((frame) => frame.type === "hello");
    first.ws.terminate();
    await expect(connect(server.workspaceId, { ticket, headers: {} })).rejects.toThrow();
  });

  it("tickets are workspace-bound: the wrong workspaceId is refused", async () => {
    server = await makeTestServer();
    const ticket = await mintTicket(server.workspaceId);
    const otherWorkspace = "22222222-3333-4444-8555-666666666666";
    await expect(connect(otherWorkspace, { ticket, headers: {} })).rejects.toThrow();
  });

  it("tickets expire: a TTL-shortened ticket dies on schedule", async () => {
    server = await makeTestServer({ wsTicketTtlMs: 50 });
    const ticket = await mintTicket(server.workspaceId);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await expect(connect(server.workspaceId, { ticket, headers: {} })).rejects.toThrow();
  });

  it("retired: ?token= credentials are refused outright", async () => {
    server = await makeTestServer();
    await expect(
      connect(server.workspaceId, {
        query: `?token=${encodeURIComponent(server.apiKey)}`,
        headers: {},
      }),
    ).rejects.toThrow();
  });

  it("minting requires a valid credential", async () => {
    server = await makeTestServer();
    const res = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/tickets",
      headers: { "content-type": "application/json" },
      payload: { workspaceId: server.workspaceId },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthenticated");
  });

  it("minting validates the body strictly", async () => {
    server = await makeTestServer();
    const res = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/tickets",
      headers: { "content-type": "application/json", ...server.authHeaders },
      payload: { workspaceId: server.workspaceId, extra: true },
    });
    expect(res.statusCode).toBe(422);
  });
});
