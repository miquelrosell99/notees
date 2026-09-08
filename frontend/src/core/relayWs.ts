/**
 * RelayWsClient — realtime channel to the operation relay
 * (/api/relay/ws/{workspaceId}).
 *
 * The WebSocket is strictly an acceleration path: it delivers committed
 * batches with their server-assigned seqs so the client can apply them
 * immediately, but the seq cursor + HTTP catch-up remain the authoritative
 * recovery mechanism. A dropped socket is indistinguishable from a delayed
 * one — on (re)connect the consumer compares `hello.latestSeq` against its
 * stored cursor and catches up over HTTP if behind.
 *
 * Framing (WS_PROTOCOL_VERSION = 2, protocol/SPEC.md §5):
 *   server → client: hello { protocolVersion, restoreEpoch, latestSeq }
 *   server → client: ops { protocolVersion, envelopes, seqs }
 * A peer speaking a newer framing version is rejected loudly (no silent
 * degradation, no reconnect loop).
 */

import type { OperationEnvelope } from './crypto';
import { getServerUrl } from '@/config/serverUrl';
import { getLogger } from '@/utils/logger';

const log = getLogger('relayWs');

export const RELAY_WS_PROTOCOL_VERSION = 2;

const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** Minimal socket surface so tests can inject a fake. */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  close(code?: number, reason?: string): void;
}

export interface RelayWsHello {
  restoreEpoch: number;
  latestSeq: number;
}

export interface RelayWsCallbacks {
  onHello: (hello: RelayWsHello) => void;
  onOps: (envelopes: OperationEnvelope[], seqs: Record<string, number>) => void;
  /** Fatal framing errors (e.g. newer protocol version); the client stops. */
  onFatal?: (message: string) => void;
  onClose?: (code: number) => void;
}

export interface RelayWsClientOptions {
  workspaceId: string;
  /** Server origin override; defaults to the configured server URL or same-origin. */
  baseUrl?: string;
  callbacks: RelayWsCallbacks;
  createSocket?: (url: string) => WebSocketLike;
  reconnectDelaysMs?: number[];
}

function defaultCreateSocket(url: string): WebSocketLike {
  return new WebSocket(url) as WebSocketLike;
}

export function relayWsUrl(workspaceId: string, baseUrl?: string): string {
  const origin = baseUrl ?? getServerUrl() ?? window.location.origin;
  const wsOrigin = origin.replace(/^http/, 'ws').replace(/\/$/, '');
  return `${wsOrigin}/api/relay/ws/${encodeURIComponent(workspaceId)}`;
}

export class RelayWsClient {
  private readonly workspaceId: string;
  private readonly baseUrl?: string;
  private readonly callbacks: RelayWsCallbacks;
  private readonly createSocket: (url: string) => WebSocketLike;
  private readonly reconnectDelays: number[];
  private socket: WebSocketLike | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private fatal = false;

  constructor(options: RelayWsClientOptions) {
    this.workspaceId = options.workspaceId;
    this.baseUrl = options.baseUrl;
    this.callbacks = options.callbacks;
    this.createSocket = options.createSocket ?? defaultCreateSocket;
    this.reconnectDelays = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
  }

  connect(): void {
    if (this.socket || this.fatal) return;
    this.intentionalClose = false;
    const url = relayWsUrl(this.workspaceId, this.baseUrl);
    const socket = this.createSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempt = 0;
    };
    socket.onmessage = (event) => {
      this.handleMessage(event);
    };
    socket.onerror = () => {
      // The close event follows and drives reconnect; nothing to do here.
    };
    socket.onclose = (event) => {
      this.socket = null;
      this.callbacks.onClose?.(event.code);
      if (this.intentionalClose || this.fatal) return;
      // 1008 = policy violation (auth/permission). Reconnecting would churn;
      // surface it and stop — re-auth reinitializes the workspace anyway.
      if (event.code === 1008) {
        this.fatal = true;
        this.callbacks.onFatal?.('Relay WebSocket rejected (auth or permission).');
        return;
      }
      this.scheduleReconnect();
    };
  }

  /** Close intentionally; no reconnect. */
  close(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private scheduleReconnect(): void {
    const delay =
      this.reconnectDelays[Math.min(this.reconnectAttempt, this.reconnectDelays.length - 1)];
    this.reconnectAttempt += 1;
    log.info('Relay WebSocket closed; reconnecting', { delay, attempt: this.reconnectAttempt });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handleMessage(event: MessageEvent): void {
    let frame: unknown;
    try {
      frame = JSON.parse(event.data as string);
    } catch {
      log.warn('Ignoring malformed relay WS frame');
      return;
    }
    if (typeof frame !== 'object' || frame === null || !('type' in frame)) {
      log.warn('Ignoring untyped relay WS frame');
      return;
    }
    const typed = frame as { type: string; protocolVersion?: number };

    if (typed.type === 'hello' || typed.type === 'ops') {
      if ((typed.protocolVersion ?? 0) > RELAY_WS_PROTOCOL_VERSION) {
        // Fail loud: a newer framing version may carry semantics we cannot
        // interpret. Stop instead of silently desyncing.
        this.fatal = true;
        this.callbacks.onFatal?.(
          `Relay WebSocket speaks framing version ${typed.protocolVersion}, we understand ${RELAY_WS_PROTOCOL_VERSION}.`
        );
        this.socket?.close();
        this.socket = null;
        return;
      }
    }

    if (typed.type === 'hello') {
      const hello = typed as unknown as {
        restoreEpoch?: number;
        latestSeq?: number;
      };
      this.callbacks.onHello({
        restoreEpoch: hello.restoreEpoch ?? 0,
        latestSeq: hello.latestSeq ?? 0,
      });
      return;
    }

    if (typed.type === 'ops') {
      const ops = typed as unknown as {
        envelopes?: OperationEnvelope[];
        seqs?: Record<string, number>;
      };
      this.callbacks.onOps(ops.envelopes ?? [], ops.seqs ?? {});
      return;
    }
    // ack/error frames target WS-push clients; the web client pushes over
    // HTTP, so they are safely ignored here.
  }
}
