// @vitest-environment node
/**
 * WebSocket client tests (WIRE.md): a tiny `ws`-based fake relay speaks
 * hello/ops/ack/error frames over `/api/relay/v2/ws/{workspaceId}?ticket=…`,
 * minting single-use tickets at `POST /api/relay/v2/tickets` exactly like the
 * real server. Asserts frame dispatch, fail-loud on a newer framing version,
 * ticket minting on every connect (including reconnects), fail-loud when the
 * relay offers no tickets, reconnect with backoff after an abnormal close,
 * and a clean stop with no reconnect. Real timers with a short injected
 * backoff schedule (the default is 1s/2s/5s/10s/30s) so the WS I/O stays
 * genuinely asynchronous. The client is receive-only on the socket (push
 * stays on HTTP POST /batch), so the relay's inbound `batch` path is not
 * exercised here.
 */

import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer, type WebSocket as WsSocket } from "ws";

import { newEnvelope, type Envelope } from "@notees/protocol";

import {
  HttpTransport,
  TransportError,
  WS_PROTOCOL_VERSION,
  type RealtimeHandlers,
  type WebSocketImpl,
} from "../src/index.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const T0 = 1_727_200_000_000;

/** Short backoff for tests; the production default is [1s,2s,5s,10s,30s]. */
const TEST_DELAYS_MS = [50, 100, 200] as const;

function makeEnvelope(deviceId: string, physical: number, name: string): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId,
    hlc: { physical, logical: 0 },
    opType: "object.create",
    payload: { objectId: `${deviceId}-${physical}`, contentAst: [{ type: "text", text: name }] },
    timestamp: new Date(physical).toISOString(),
  });
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Minimal fake relay: the real server's admission flow — POST /tickets with
 * the X-API-Key header mints a single-use ticket; the socket requires it in
 * ?ticket= and refuses anything carrying a `token` param (the retired
 * credential-in-URL path). Envelope seq assignment + ops/ack broadcast.
 */
class FakeRelay {
  readonly server: Server;
  private readonly wss: WebSocketServer;
  private readonly sockets = new Set<WsSocket>();
  /** One entry per accepted connection (path), for assertions. */
  readonly connections: string[] = [];
  /** Raw query strings of upgrade attempts, to assert no credential in URLs. */
  readonly upgradeQueries: string[] = [];
  /** Number of ticket-mint requests received (successes + rejections). */
  mintAttempts = 0;
  /** Number of successful ticket mints — one expected per connect. */
  mintCount = 0;
  private readonly liveTickets = new Set<string>();
  private readonly log: Envelope[] = [];
  private readonly seqById = new Map<string, number>();
  private seq = 0;

  constructor(
    private readonly options: { wsProtocolVersion?: number; noTickets?: boolean } = {},
  ) {
    this.wss = new WebSocketServer({ noServer: true });
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/api/relay/v2/tickets" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          this.mintAttempts += 1;
          if (this.options.noTickets === true) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { code: "not_found", message: "no such route", status: 404 } }));
            return;
          }
          if (req.headers["x-api-key"] !== "test-key") {
            res.writeHead(401, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                error: { code: "unauthenticated", message: "invalid or missing credentials", status: 401 },
              }),
            );
            return;
          }
          this.mintCount += 1;
          const ticket = `ntk_test_${randomBytes(12).toString("base64url")}`;
          this.liveTickets.add(ticket);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ticket, expiresAt: Date.now() + 60_000 }));
        });
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not_found", message: "no such route", status: 404 } }));
    });
    this.server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      this.upgradeQueries.push(url.search);
      const ticket = url.searchParams.get("ticket");
      // Single-use: an admitted ticket is consumed; a refused attempt dies too.
      const admitted = ticket !== null && this.liveTickets.has(ticket);
      if (ticket !== null) this.liveTickets.delete(ticket);
      if (!admitted || url.searchParams.get("token") !== null) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (wsSocket) => {
        this.connections.push(url.pathname);
        this.sockets.add(wsSocket);
        wsSocket.on("close", () => this.sockets.delete(wsSocket));
        wsSocket.send(
          JSON.stringify({
            type: "hello",
            wsProtocolVersion: this.options.wsProtocolVersion ?? WS_PROTOCOL_VERSION,
            restoreEpoch: 0,
            latestSeq: this.seq,
          }),
        );
      });
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
  }

  get port(): number {
    return (this.server.address() as { port: number }).port;
  }

  get clientCount(): number {
    return this.sockets.size;
  }

  get connectionCount(): number {
    return this.connections.length;
  }

  private ingest(envelopes: Envelope[]): { savedIds: string[]; seqs: Record<string, number> } {
    const savedIds: string[] = [];
    const seqs: Record<string, number> = {};
    for (const envelope of envelopes) {
      if (this.seqById.has(envelope.id)) continue;
      this.seq += 1;
      this.log.push(envelope);
      this.seqById.set(envelope.id, this.seq);
      savedIds.push(envelope.id);
      seqs[envelope.id] = this.seq;
    }
    return { savedIds, seqs };
  }

  private broadcastOps(savedIds: string[], seqs: Record<string, number>): void {
    const committed = savedIds.map((id) => this.log[this.seqById.get(id)! - 1]!);
    this.broadcast({
      type: "ops",
      wsProtocolVersion: WS_PROTOCOL_VERSION,
      envelopes: committed,
      seqs,
    });
  }

  /** Another device committed (over HTTP): broadcast the ops frame. */
  commit(envelopes: Envelope[], options: { ack?: boolean } = {}): void {
    const { savedIds, seqs } = this.ingest(envelopes);
    this.broadcastOps(savedIds, seqs);
    if (options.ack === true) this.broadcast({ type: "ack", savedIds });
  }

  broadcast(frame: Record<string, unknown>): void {
    const raw = JSON.stringify(frame);
    for (const socket of this.sockets) socket.send(raw);
  }

  /** Simulate a dropped socket (abnormal close from the client's view). */
  dropAll(): void {
    for (const socket of this.sockets) socket.terminate();
  }

  async close(): Promise<void> {
    this.dropAll();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const relays: FakeRelay[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  while (cleanups.length > 0) cleanups.pop()!();
  while (relays.length > 0) await relays.pop()!.close();
});

async function makeRelay(options: { wsProtocolVersion?: number; noTickets?: boolean } = {}): Promise<FakeRelay> {
  const relay = new FakeRelay(options);
  relays.push(relay);
  await relay.listen();
  return relay;
}

function makeTransport(
  relay: FakeRelay,
  options: { apiKey?: string; delays?: readonly number[] } = {},
): HttpTransport {
  return new HttpTransport({
    baseUrl: `http://127.0.0.1:${relay.port}`,
    apiKey: options.apiKey ?? "test-key",
    workspaceId: WS,
    webSocketImpl: WebSocket as unknown as WebSocketImpl,
    wsReconnectDelaysMs: options.delays ?? TEST_DELAYS_MS,
  });
}

function subscribe(transport: HttpTransport, handlers: RealtimeHandlers): () => void {
  const stop = transport.subscribe(handlers);
  cleanups.push(stop);
  return stop;
}

describe("HttpTransport.subscribe (WS acceleration path)", () => {
  it("connects with a minted ticket and dispatches hello/ops/ack/error frames; ignores unknown frames", async () => {
    const relay = await makeRelay();
    const transport = makeTransport(relay);
    const hello = vi.fn();
    const ops = vi.fn();
    const ack = vi.fn();
    const onError = vi.fn();
    subscribe(transport, { onHello: hello, onOps: ops, onAck: ack, onError });

    // hello on connect, with the relay's current seq cursor.
    await waitFor(() => hello.mock.calls.length === 1, "hello frame");
    expect(hello).toHaveBeenCalledWith({ latestSeq: 0, restoreEpoch: 0 });
    expect(relay.connections).toEqual([`/api/relay/v2/ws/${WS}`]);
    expect(relay.mintCount).toBe(1);
    // The credential never rides the URL: every upgrade carried a ticket
    // and none carried the retired token param.
    expect(relay.upgradeQueries).toHaveLength(1);
    expect(relay.upgradeQueries[0]).toMatch(/^\?ticket=ntk_/);
    expect(relay.upgradeQueries[0]).not.toContain("token=");

    // ops frame → onOps with envelopes + the id→seq map.
    const envelope = makeEnvelope("device-b", T0 + 10, "from-B");
    relay.commit([envelope]);
    await waitFor(() => ops.mock.calls.length === 1, "ops frame");
    expect(ops).toHaveBeenCalledWith([envelope], { [envelope.id]: 1 });

    // ack frame → onAck.
    relay.broadcast({ type: "ack", savedIds: [envelope.id] });
    await waitFor(() => ack.mock.calls.length === 1, "ack frame");
    expect(ack).toHaveBeenCalledWith([envelope.id]);

    // error frame → onError.
    relay.broadcast({ type: "error", message: "relay says no" });
    await waitFor(() => onError.mock.calls.length === 1, "error frame");
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0]![0].message).toBe("relay says no");

    // Unknown frame types are ignored (no dispatch, no error).
    relay.broadcast({ type: "future_frame_v99", payload: { x: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ops.mock.calls.length).toBe(1);
    expect(ack.mock.calls.length).toBe(1);
    expect(onError.mock.calls.length).toBe(1);
  });

  it("rejects a bad credential at mint time with the relay's error envelope", async () => {
    const relay = await makeRelay();
    const transport = makeTransport(relay, { apiKey: "wrong-key" });
    const onError = vi.fn();
    const hello = vi.fn();
    subscribe(transport, { onError, onHello: hello });

    await waitFor(() => onError.mock.calls.length === 1, "unauthenticated mint error");
    const error = onError.mock.calls[0]![0] as TransportError;
    expect(error).toBeInstanceOf(TransportError);
    expect(error.code).toBe("unauthenticated");
    expect(hello).not.toHaveBeenCalled();
    // A refused credential keeps retrying (backoff) — a credential refresh
    // out-of-band may fix the next attempt.
    await waitFor(() => relay.mintAttempts >= 2, "retrying mints");
  });

  it("fails loud when the relay does not offer tickets (mint 404): error emitted, no reconnect", async () => {
    const relay = await makeRelay({ noTickets: true });
    const transport = makeTransport(relay);
    const onError = vi.fn();
    const hello = vi.fn();
    subscribe(transport, { onError, onHello: hello });

    await waitFor(() => onError.mock.calls.length === 1, "fail-loud no-tickets error");
    expect(onError.mock.calls[0]![0].message).toMatch(/does not offer WS admission tickets/);
    expect(hello).not.toHaveBeenCalled();

    // Well past the first backoff step: reconnecting cannot fix a 404.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(relay.mintAttempts).toBe(1);
    expect(relay.connections).toHaveLength(0);
  });

  it("fails loud on a newer framing version: error emitted, closed, no reconnect", async () => {
    const relay = await makeRelay({ wsProtocolVersion: WS_PROTOCOL_VERSION + 1 });
    const transport = makeTransport(relay);
    const onError = vi.fn();
    const hello = vi.fn();
    subscribe(transport, { onError, onHello: hello });

    await waitFor(() => onError.mock.calls.length === 1, "fail-loud error");
    expect(onError.mock.calls[0]![0].message).toMatch(/newer than supported/);
    expect(hello).not.toHaveBeenCalled();
    await waitFor(() => relay.clientCount === 0, "socket closed");

    // Well past the first backoff step: the client must not reconnect.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(relay.connectionCount).toBe(1);
  });

  it("reconnects with backoff after an abnormal close and resumes delivery", async () => {
    const relay = await makeRelay();
    const transport = makeTransport(relay);
    const hello = vi.fn();
    const ops = vi.fn();
    subscribe(transport, { onHello: hello, onOps: ops });

    await waitFor(() => hello.mock.calls.length === 1, "initial hello");

    // Server drops the socket; the client re-mints and reconnects.
    relay.dropAll();
    await waitFor(() => relay.connectionCount === 2, "reconnect");
    await waitFor(() => hello.mock.calls.length === 2, "second hello");
    expect(relay.mintCount).toBe(2);

    // An ops frame committed after the reconnect is delivered.
    const envelope = makeEnvelope("device-b", T0 + 20, "after-reconnect");
    relay.commit([envelope]);
    await waitFor(() => ops.mock.calls.length === 1, "ops after reconnect");
    expect(ops).toHaveBeenCalledWith([envelope], { [envelope.id]: 1 });
  });

  it("stops cleanly: socket closed, pending backoff cancelled, no reconnect", async () => {
    const relay = await makeRelay();
    const transport = makeTransport(relay);
    const hello = vi.fn();
    const stop = subscribe(transport, { onHello: hello });
    await waitFor(() => hello.mock.calls.length === 1, "initial hello");

    stop();
    await waitFor(() => relay.clientCount === 0, "clean close");

    // Even an abnormal server-side close after stop must not reconnect.
    relay.dropAll();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(relay.connectionCount).toBe(1);
  });

  it("fails loud when no WebSocket implementation is available", () => {
    // Node ≥22 has a native global WebSocket; shadow it to simulate a host
    // without one (the app always injects none — it relies on the browser
    // built-in, which this asserts is required).
    const host = globalThis as { WebSocket?: unknown };
    const original = Object.getOwnPropertyDescriptor(host, "WebSocket");
    Object.defineProperty(host, "WebSocket", { value: undefined, configurable: true, writable: true });
    try {
      const transport = new HttpTransport({
        baseUrl: "http://127.0.0.1:9",
        apiKey: "test-key",
        workspaceId: WS,
      });
      expect(() => transport.subscribe({})).toThrow(/no WebSocket available/);
    } finally {
      if (original !== undefined) Object.defineProperty(host, "WebSocket", original);
    }
  });
});
