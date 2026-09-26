/**
 * Transports: the fetch-based HTTP client (WIRE.md §1) with the WebSocket
 * acceleration path (WIRE.md §2), plus an in-process fake relay (array-backed
 * envelope log with server seq assignment) used by tests and local
 * development. The WS client is structural over a minimal WebSocket shape so
 * the browser built-in is used in the app and the `ws` package in Node tests
 * (injected via `webSocketImpl`).
 */

import type { Envelope, Hlc } from "@notees/protocol";

import { TransportError } from "./errors.js";
import type {
  CatchUpResponse,
  RealtimeHandlers,
  SendBatchResult,
  SnapshotMeta,
  Transport,
} from "./types.js";

// --- HTTP ----------------------------------------------------------------------

export interface HttpTransportOptions {
  baseUrl: string;
  apiKey: string;
  workspaceId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Injectable WebSocket (tests/Node); defaults to globalThis.WebSocket. */
  webSocketImpl?: WebSocketImpl;
  /** Reconnect backoff after abnormal closes; defaults to 1s,2s,5s,10s,30s. */
  wsReconnectDelaysMs?: readonly number[];
}

/** WIRE.md §2 framing version; a newer one from the relay fails loud. */
export const WS_PROTOCOL_VERSION = 2;

const DEFAULT_WS_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

// --- WebSocket (structural, so both the browser built-in and `ws` fit) ---------

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type WebSocketImpl = new (url: string) => WebSocketLike;

function defaultWebSocketImpl(): WebSocketImpl | null {
  return (globalThis as { WebSocket?: WebSocketImpl }).WebSocket ?? null;
}

async function toTransportError(response: Response): Promise<TransportError> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    if (body.error && typeof body.error.code === "string") {
      return new TransportError(
        body.error.code,
        body.error.message ?? response.statusText,
        response.status,
      );
    }
  } catch {
    // Not the JSON error envelope; fall through to a generic HTTP error.
  }
  return new TransportError("http_error", `HTTP ${response.status}: ${response.statusText}`, response.status);
}

export class HttpTransport implements Transport {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly workspaceId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly webSocketImpl: WebSocketImpl | null;
  private readonly wsReconnectDelaysMs: readonly number[];

  constructor(options: HttpTransportOptions) {
    this.base = `${options.baseUrl.replace(/\/$/, "")}/api/relay/v2`;
    this.apiKey = options.apiKey;
    this.workspaceId = options.workspaceId;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.webSocketImpl = options.webSocketImpl ?? defaultWebSocketImpl();
    this.wsReconnectDelaysMs = options.wsReconnectDelaysMs ?? DEFAULT_WS_RECONNECT_DELAYS_MS;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = new Headers(init.headers);
    headers.set("X-API-Key", this.apiKey);
    try {
      const response = await this.fetchImpl(`${this.base}${path}`, {
        ...init,
        signal: controller.signal,
        headers,
      });
      if (!response.ok) throw await toTransportError(response);
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async sendBatch(envelopes: Envelope[]): Promise<SendBatchResult> {
    const response = await this.request("/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envelopes }),
    });
    const data = (await response.json()) as Partial<SendBatchResult>;
    return {
      savedCount: typeof data.savedCount === "number" ? data.savedCount : 0,
      savedIds: Array.isArray(data.savedIds) ? (data.savedIds as string[]) : [],
    };
  }

  async catchUp(afterSeq: number, limit = 1000): Promise<CatchUpResponse> {
    const response = await this.request("/catch-up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: this.workspaceId, afterSeq, limit }),
    });
    return (await response.json()) as CatchUpResponse;
  }

  async getSnapshotMeta(): Promise<SnapshotMeta> {
    const response = await this.request(
      `/snapshot?workspaceId=${encodeURIComponent(this.workspaceId)}`,
    );
    return (await response.json()) as SnapshotMeta;
  }

  async getSnapshotData(): Promise<Uint8Array> {
    const response = await this.request(
      `/snapshot/data?workspaceId=${encodeURIComponent(this.workspaceId)}`,
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  async uploadSnapshot(bytes: Uint8Array, hlc: Hlc): Promise<void> {
    const params = new URLSearchParams({
      workspaceId: this.workspaceId,
      physical: String(hlc.physical),
      logical: String(hlc.logical),
    });
    await this.request(`/snapshot/data?${params.toString()}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      // Cross-lib typing: Uint8Array<ArrayBufferLike> vs DOM RequestInit.body.
      // Both Node ≥18 and DOM fetch accept it at runtime.
      body: bytes as unknown as NonNullable<RequestInit["body"]>,
    });
  }

  // --- WebSocket acceleration path (WIRE.md §2) --------------------------------

  /**
   * Subscribe to the workspace's realtime stream. Connects to
   * `/api/relay/v2/ws/{workspaceId}?token=…`, dispatches frames to the
   * handlers, reconnects with backoff after abnormal closes (the seq cursor in
   * meta.ts is the authoritative recovery mechanism — the socket is only an
   * accelerator), and fails loud when the relay speaks a newer framing
   * version. The returned function stops the stream: pending reconnects are
   * cancelled and the open socket is closed cleanly (code 1000, no reconnect).
   */
  subscribe(handlers: RealtimeHandlers): () => void {
    if (this.webSocketImpl === null) {
      throw new Error(
        "HttpTransport.subscribe: no WebSocket available (pass webSocketImpl in Node)",
      );
    }
    const url =
      `${this.base.replace(/^http/, "ws")}/ws/${encodeURIComponent(this.workspaceId)}` +
      `?token=${encodeURIComponent(this.apiKey)}`;
    const delays = this.wsReconnectDelaysMs;

    let stopped = false;
    /** Fail-loud (newer framing): error emitted, socket closed, never reconnects. */
    let failed = false;
    let socket: WebSocketLike | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const failLoud = (message: string): void => {
      failed = true;
      handlers.onError?.(new Error(message));
      const current = socket;
      socket = null;
      if (current !== null && current.readyState <= 1) {
        try {
          current.close(1000);
        } catch {
          // Already closing/closed.
        }
      }
    };

    const handleFrame = (raw: unknown): void => {
      let frame: Record<string, unknown>;
      try {
        let text: string | null = null;
        if (typeof raw === "string") {
          text = raw;
        } else if (raw instanceof ArrayBuffer) {
          text = new TextDecoder().decode(raw);
        } else if (ArrayBuffer.isView(raw)) {
          text = new TextDecoder().decode(
            new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
          );
        }
        if (text === null) return;
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null) return;
        frame = parsed as Record<string, unknown>;
      } catch {
        return; // Malformed frame: ignore, matching unknown-frame semantics.
      }

      const type = frame["type"];
      if (type === "hello") {
        const version =
          typeof frame["wsProtocolVersion"] === "number"
            ? (frame["wsProtocolVersion"] as number)
            : 0;
        if (version > WS_PROTOCOL_VERSION) {
          failLoud(
            `relay WS framing version ${version} is newer than supported ${WS_PROTOCOL_VERSION}`,
          );
          return;
        }
        attempt = 0; // Successful handshake: reset the backoff schedule.
        handlers.onHello?.({
          latestSeq: typeof frame["latestSeq"] === "number" ? frame["latestSeq"] : 0,
          restoreEpoch:
            typeof frame["restoreEpoch"] === "number" ? frame["restoreEpoch"] : 0,
        });
      } else if (type === "ops") {
        const version =
          typeof frame["wsProtocolVersion"] === "number"
            ? (frame["wsProtocolVersion"] as number)
            : 0;
        if (version > WS_PROTOCOL_VERSION) {
          failLoud(
            `relay WS framing version ${version} is newer than supported ${WS_PROTOCOL_VERSION}`,
          );
          return;
        }
        const envelopes = Array.isArray(frame["envelopes"])
          ? (frame["envelopes"] as Envelope[])
          : [];
        const seqs =
          typeof frame["seqs"] === "object" && frame["seqs"] !== null
            ? (frame["seqs"] as Record<string, number>)
            : {};
        handlers.onOps?.(envelopes, seqs);
      } else if (type === "ack") {
        handlers.onAck?.(Array.isArray(frame["savedIds"]) ? (frame["savedIds"] as string[]) : []);
      } else if (type === "error") {
        handlers.onError?.(
          new Error(typeof frame["message"] === "string" ? frame["message"] : "relay error"),
        );
      }
      // Unknown frame types are ignored (WIRE.md §2).
    };

    const connect = (): void => {
      if (stopped || failed) return;
      let conn: WebSocketLike;
      try {
        conn = new this.webSocketImpl!(url);
      } catch (err) {
        handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
        scheduleReconnect();
        return;
      }
      socket = conn;
      conn.onopen = () => {};
      conn.onmessage = (event) => handleFrame(event.data);
      conn.onerror = null;
      conn.onclose = () => {
        if (socket !== conn) return; // Superseded or already torn down.
        socket = null;
        scheduleReconnect();
      };
    };

    const scheduleReconnect = (): void => {
      if (stopped || failed || reconnectTimer !== null) return;
      const delay = delays[Math.min(attempt, delays.length - 1)]!;
      attempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const current = socket;
      socket = null;
      if (current !== null && current.readyState <= 1) {
        try {
          current.close(1000);
        } catch {
          // Already closing/closed.
        }
      }
    };
  }
}

// --- in-process fake relay -------------------------------------------------------

interface RelayRow {
  envelope: Envelope;
  seq: number;
}

/**
 * Array-backed envelope log with WIRE.md server semantics: seq assignment at
 * ingest, idempotent duplicate-id ingest, catch-up pagination (ascending seq,
 * nextAfterSeq covering the tail of each page), snapshot blob storage, and a
 * restoreEpoch counter. Subscribers receive ops frames — the WS acceleration
 * path — on every committed batch.
 */
export class MemoryRelay {
  private log: RelayRow[] = [];
  private readonly seqById = new Map<string, number>();
  private epoch = 0;
  private snapshotBytes: Buffer | null = null;
  private snapshotHlc: Hlc = { physical: 0, logical: 0 };
  private snapshotUpToSeq: number | null = null;
  private snapshotCounter = 0;
  private readonly subscribers = new Set<RealtimeHandlers>();

  /** POST /batch: duplicate ids silently ignored; new envelopes get the next seq. */
  ingest(envelopes: Envelope[]): SendBatchResult {
    const savedIds: string[] = [];
    const seqs: Record<string, number> = {};
    for (const envelope of envelopes) {
      if (this.seqById.has(envelope.id)) continue;
      const seq = this.log.length + 1;
      this.log.push({ envelope, seq });
      this.seqById.set(envelope.id, seq);
      savedIds.push(envelope.id);
      seqs[envelope.id] = seq;
    }
    if (savedIds.length > 0) {
      const committed = savedIds.map(
        (id) => this.log[this.seqById.get(id)! - 1]!.envelope,
      );
      for (const subscriber of this.subscribers) {
        subscriber.onOps?.(committed, { ...seqs });
      }
    }
    return { savedCount: savedIds.length, savedIds };
  }

  /** POST /catch-up: exclusive lower bound, ascending seq, tail-covering cursor. */
  catchUp(afterSeq: number, limit = 1000): CatchUpResponse {
    const remaining = this.log.filter((row) => row.seq > afterSeq);
    const page = remaining.slice(0, limit);
    return {
      envelopes: page.map((row) => row.envelope),
      nextAfterSeq: page.length > 0 ? page[page.length - 1]!.seq : null,
      hasMore: remaining.length > page.length,
      restoreEpoch: this.epoch,
      totalRemaining: remaining.length,
    };
  }

  getSnapshotMeta(): SnapshotMeta {
    this.snapshotCounter += 1;
    return {
      snapshotId: this.snapshotBytes !== null ? `mem-snap-${this.snapshotCounter}` : "",
      hlc: this.snapshotHlc,
      hasSnapshot: this.snapshotBytes !== null,
      restoreEpoch: this.epoch,
      upToSeq: this.snapshotUpToSeq,
    };
  }

  getSnapshotData(): Uint8Array {
    if (this.snapshotBytes === null) {
      throw new TransportError("not_found", "no snapshot stored", 404);
    }
    return this.snapshotBytes;
  }

  /** PUT /snapshot/data: record a client-produced snapshot covering the whole log. */
  putSnapshot(bytes: Uint8Array, hlc: Hlc): void {
    this.snapshotBytes = Buffer.from(bytes);
    this.snapshotHlc = hlc;
    this.snapshotUpToSeq = this.log.length;
  }

  /** Simulate a server restore/backup swap: epoch bumps, optionally replacing the log. */
  bumpRestoreEpoch(options: { clearLog?: boolean } = {}): void {
    this.epoch += 1;
    if (options.clearLog) {
      this.log = [];
      this.seqById.clear();
      this.snapshotBytes = null;
      this.snapshotUpToSeq = null;
    }
  }

  get restoreEpoch(): number {
    return this.epoch;
  }

  get envelopeCount(): number {
    return this.log.length;
  }

  subscribe(handlers: RealtimeHandlers): () => void {
    this.subscribers.add(handlers);
    return () => this.subscribers.delete(handlers);
  }
}

export interface MemoryTransportOptions {
  /** Test hook: throw from sendBatch to simulate outages (transport-level). */
  hooks?: {
    beforeSendBatch?: (envelopes: Envelope[]) => void | Promise<void>;
  };
}

/** In-process Transport against a shared MemoryRelay (one per "device"). */
export class MemoryTransport implements Transport {
  constructor(
    private readonly relay: MemoryRelay,
    private readonly options: MemoryTransportOptions = {},
  ) {}

  async sendBatch(envelopes: Envelope[]): Promise<SendBatchResult> {
    await this.options.hooks?.beforeSendBatch?.(envelopes);
    return this.relay.ingest(envelopes);
  }

  async catchUp(afterSeq: number, limit = 1000): Promise<CatchUpResponse> {
    return this.relay.catchUp(afterSeq, limit);
  }

  async getSnapshotMeta(): Promise<SnapshotMeta> {
    return this.relay.getSnapshotMeta();
  }

  async getSnapshotData(): Promise<Uint8Array> {
    return this.relay.getSnapshotData();
  }

  async uploadSnapshot(bytes: Uint8Array, hlc: Hlc): Promise<void> {
    this.relay.putSnapshot(bytes, hlc);
  }

  subscribe(handlers: RealtimeHandlers): () => void {
    return this.relay.subscribe(handlers);
  }
}
