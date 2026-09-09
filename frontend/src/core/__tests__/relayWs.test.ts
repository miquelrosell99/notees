import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RelayWsClient, relayWsUrl, type WebSocketLike } from '../relayWs';
import { uuidv7 } from '../uuid';

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];

  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  close = vi.fn((code?: number) => {
    this.readyState = 3;
    if (code !== undefined) {
      this.emitClose(code);
    }
  });
  send = vi.fn((data: string) => {
    void data;
  });

  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  emitMessage(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }

  emitClose(code = 1006): void {
    this.onclose?.({ code } as CloseEvent);
  }
}

function lastSocket(): FakeSocket {
  const socket = FakeSocket.instances.at(-1);
  if (!socket) throw new Error('no socket created');
  return socket;
}

describe('RelayWsClient', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a ws url from the server origin', () => {
    expect(relayWsUrl('ws-1', 'http://localhost:8001')).toBe(
      'http://localhost:8001'.replace('http', 'ws') + '/api/relay/ws/ws-1'
    );
    expect(relayWsUrl('ws 1', 'https://example.com/')).toBe(
      'wss://example.com/api/relay/ws/ws%201'
    );
  });

  it('dispatches hello and ops frames to callbacks', () => {
    const hello = vi.fn();
    const ops = vi.fn();
    const client = new RelayWsClient({
      workspaceId: uuidv7(),
      baseUrl: 'http://localhost:8001',
      callbacks: { onHello: hello, onOps: ops },
      createSocket: (url) => new FakeSocket(url),
    });
    client.connect();
    const socket = lastSocket();
    socket.emitOpen();

    socket.emitMessage({ type: 'hello', protocolVersion: 2, restoreEpoch: 3, latestSeq: 41 });
    expect(hello).toHaveBeenCalledWith({ restoreEpoch: 3, latestSeq: 41 });

    const envelopes = [{ id: 'op-1' }, { id: 'op-2' }];
    socket.emitMessage({
      type: 'ops',
      protocolVersion: 2,
      envelopes,
      seqs: { 'op-1': 42, 'op-2': 43 },
    });
    expect(ops).toHaveBeenCalledWith(envelopes, { 'op-1': 42, 'op-2': 43 });

    client.close();
  });

  it('stops fatally on a newer framing version instead of reconnecting', () => {
    const fatal = vi.fn();
    const client = new RelayWsClient({
      workspaceId: uuidv7(),
      baseUrl: 'http://localhost:8001',
      callbacks: { onHello: vi.fn(), onOps: vi.fn(), onFatal: fatal },
      createSocket: (url) => new FakeSocket(url),
    });
    client.connect();
    const socket = lastSocket();
    socket.emitOpen();
    socket.emitMessage({ type: 'hello', protocolVersion: 99, restoreEpoch: 0, latestSeq: 0 });

    expect(fatal).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_000);
    // No reconnect attempts after a fatal framing error.
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('reconnects with backoff after an abnormal close', () => {
    const client = new RelayWsClient({
      workspaceId: uuidv7(),
      baseUrl: 'http://localhost:8001',
      callbacks: { onHello: vi.fn(), onOps: vi.fn() },
      createSocket: (url) => new FakeSocket(url),
      reconnectDelaysMs: [1_000, 2_000],
    });
    client.connect();
    lastSocket().emitOpen();
    lastSocket().emitClose(1006);
    expect(FakeSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.instances).toHaveLength(2);

    lastSocket().emitOpen();
    lastSocket().emitClose(1006);
    vi.advanceTimersByTime(2_000);
    expect(FakeSocket.instances).toHaveLength(3);

    client.close();
  });

  it('does not reconnect after an intentional close or a 1008 policy violation', () => {
    const fatal = vi.fn();
    const client = new RelayWsClient({
      workspaceId: uuidv7(),
      baseUrl: 'http://localhost:8001',
      callbacks: { onHello: vi.fn(), onOps: vi.fn(), onFatal: fatal },
      createSocket: (url) => new FakeSocket(url),
      reconnectDelaysMs: [1_000],
    });
    client.connect();
    lastSocket().emitClose(1008);
    expect(fatal).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(1);

    const client2 = new RelayWsClient({
      workspaceId: uuidv7(),
      baseUrl: 'http://localhost:8001',
      callbacks: { onHello: vi.fn(), onOps: vi.fn() },
      createSocket: (url) => new FakeSocket(url),
      reconnectDelaysMs: [1_000],
    });
    client2.connect();
    client2.close();
    lastSocket().emitClose(1006);
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(2);
  });
});

describe('RelayWsClient presence + status', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispatches presence frames to onPresence and still ignores unknown types', () => {
    const presence = vi.fn();
    const client = new RelayWsClient({
      workspaceId: uuidv7(),
      baseUrl: 'http://localhost:8001',
      callbacks: { onHello: vi.fn(), onOps: vi.fn(), onPresence: presence },
      createSocket: (url) => new FakeSocket(url),
    });
    client.connect();
    const socket = lastSocket();
    socket.emitOpen();

    const frame = {
      type: 'presence',
      action: 'user_focus',
      blockUuid: 'block-1',
      user: { id: 'user-1', name: 'Alice', color: '#ef4444' },
    };
    socket.emitMessage(frame);
    expect(presence).toHaveBeenCalledWith(frame);

    const list = {
      type: 'presence',
      action: 'users_list',
      users: [{ user: { id: 'user-1', name: 'Alice', color: '#ef4444' }, blockUuid: 'block-1' }],
    };
    socket.emitMessage(list);
    expect(presence).toHaveBeenCalledWith(list);

    // Unknown frame types are ignored (additive framing, SPEC §5).
    socket.emitMessage({ type: 'something_new', payload: 1 });
    expect(presence).toHaveBeenCalledTimes(2);

    client.close();
  });

  it('send() serializes frames only while the socket is open', () => {
    const client = new RelayWsClient({
      workspaceId: uuidv7(),
      baseUrl: 'http://localhost:8001',
      callbacks: { onHello: vi.fn(), onOps: vi.fn() },
      createSocket: (url) => new FakeSocket(url),
    });

    // No socket yet: safe no-op.
    client.send({ type: 'presence', action: 'focus', blockUuid: 'b1' });

    client.connect();
    const socket = lastSocket();
    // Connecting but not open: still a no-op.
    client.send({ type: 'presence', action: 'focus', blockUuid: 'b1' });
    expect(socket.send).not.toHaveBeenCalled();

    socket.emitOpen();
    client.send({ type: 'presence', action: 'focus', blockUuid: 'b1' });
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'presence', action: 'focus', blockUuid: 'b1' })
    );

    client.close();
    client.send({ type: 'presence', action: 'blur', blockUuid: 'b1' });
    expect(socket.send).toHaveBeenCalledTimes(1);
  });

  it('reports realtime status transitions', () => {
    const statuses: string[] = [];
    const client = new RelayWsClient({
      workspaceId: uuidv7(),
      baseUrl: 'http://localhost:8001',
      callbacks: { onHello: vi.fn(), onOps: vi.fn(), onStatusChange: (s) => statuses.push(s) },
      createSocket: (url) => new FakeSocket(url),
      reconnectDelaysMs: [1_000],
    });
    expect(client.getStatus()).toBe('disconnected');

    client.connect();
    expect(client.getStatus()).toBe('connecting');
    lastSocket().emitOpen();
    expect(client.getStatus()).toBe('connected');

    lastSocket().emitClose(1006);
    expect(client.getStatus()).toBe('disconnected');

    // Reconnect: back to connecting.
    vi.advanceTimersByTime(1_000);
    expect(client.getStatus()).toBe('connecting');
    lastSocket().emitOpen();
    expect(client.getStatus()).toBe('connected');

    client.close();
    expect(client.getStatus()).toBe('disconnected');
    expect(statuses).toEqual([
      'connecting',
      'connected',
      'disconnected',
      'connecting',
      'connected',
      'disconnected',
    ]);
  });

  it('reports error status on a fatal framing version', () => {
    const client = new RelayWsClient({
      workspaceId: uuidv7(),
      baseUrl: 'http://localhost:8001',
      callbacks: { onHello: vi.fn(), onOps: vi.fn(), onFatal: vi.fn() },
      createSocket: (url) => new FakeSocket(url),
    });
    client.connect();
    lastSocket().emitOpen();
    lastSocket().emitMessage({ type: 'hello', protocolVersion: 99, restoreEpoch: 0, latestSeq: 0 });
    expect(client.getStatus()).toBe('error');
  });
});
