// @vitest-environment node
/**
 * WebSocket client tests (WIRE.md): a tiny `ws`-based fake relay speaks
 * hello/ops/ack/error frames over `/api/relay/v2/ws/{workspaceId}?token=…`.
 * Asserts frame dispatch, fail-loud on a newer framing version, reconnect
 * with backoff after an abnormal close, and a clean stop with no reconnect.
 * Real timers with a short injected backoff schedule (the default is
 * 1s/2s/5s/10s/30s) so the WS I/O stays genuinely asynchronous. The client
 * is receive-only on the socket (push stays on HTTP POST /batch), so the
 * relay's inbound `batch` path is not exercised here.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer, type WebSocket as WsSocket } from "ws";

import { newEnvelope, type Envelope } from "@notees/protocol";

import {
  HttpTransport,
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

/** Minimal fake relay: auth via ?token=, seq assignment, ops/ack broadcast. */
class FakeRelay {
  readonly wss: WebSocketServer;
  private readonly sockets = new Set<WsSocket>();
  /** One entry per accepted connection (path), for assertions. */
  readonly connections: string[] = [];
  private readonly log: Envelope[] = [];
  private readonly seqById = new Map<string, number>();
  private seq = 0;

  constructor(private readonly options: { wsProtocolVersion?: number } = {}) {
    this.wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    this.wss.on("connection", (socket, req) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.searchParams.get("token") !== "test-key") {
        socket.send(JSON.stringify({ type: "error", message: "unauthenticated" }));
        socket.close();
        return;
      }
      this.connections.push(url.pathname);
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.send(
        JSON.stringify({
          type: "hello",
          wsProtocolVersion: this.options.wsProtocolVersion ?? WS_PROTOCOL_VERSION,
          restoreEpoch: 0,
          latestSeq: this.seq,
        }),
      );
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.wss.on("listening", resolve));
  }

  get port(): number {
    return (this.wss.address() as { port: number }).port;
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
  }
}

const relays: FakeRelay[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  while (cleanups.length > 0) cleanups.pop()!();
  while (relays.length > 0) await relays.pop()!.close();
});

async function makeRelay(options: { wsProtocolVersion?: number } = {}): Promise<FakeRelay> {
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
  it("connects with ?token= and dispatches hello/ops/ack/error frames; ignores unknown frames", async () => {
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

  it("rejects a bad token with an error frame", async () => {
    const relay = await makeRelay();
    const transport = makeTransport(relay, { apiKey: "wrong-key" });
    const onError = vi.fn();
    const hello = vi.fn();
    subscribe(transport, { onError, onHello: hello });

    await waitFor(() => onError.mock.calls.length === 1, "unauthenticated error frame");
    expect(onError.mock.calls[0]![0].message).toBe("unauthenticated");
    expect(hello).not.toHaveBeenCalled();
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

    // Server drops the socket; the client reconnects and gets a fresh hello.
    relay.dropAll();
    await waitFor(() => relay.connectionCount === 2, "reconnect");
    await waitFor(() => hello.mock.calls.length === 2, "second hello");

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
