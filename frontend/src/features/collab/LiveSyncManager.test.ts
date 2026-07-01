/**
 * LiveSyncManager tests — verify protocol helpers and message delivery.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleAuthFailure } from '@/utils/auth';
import { LiveSyncManager } from './LiveSyncManager';

vi.mock('@/utils/auth', () => ({
  handleAuthFailure: vi.fn(),
}));

class FakeWebSocket {
  readyState = 1; // WebSocket.OPEN
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: unknown[] = [];

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000) {
    this.onclose?.({ code } as CloseEvent);
  }
}

describe('LiveSyncManager', () => {
  let manager: LiveSyncManager;
  let socket: FakeWebSocket;

  beforeEach(() => {
    manager = new LiveSyncManager();
    socket = new FakeWebSocket();
    // Bypass the real WebSocket handshake and wire a fake socket directly.
    (manager as any).ws = socket;
    socket.onmessage = (ev: { data: string }) => (manager as any)._emit(JSON.parse(ev.data));
    (manager as any)._setStatus('connected');
  });

  afterEach(() => {
    manager.disconnect();
  });

  it('sends focus, blur, and block_update messages', () => {
    manager.sendFocus('block-a');
    manager.sendBlur('block-a');
    manager.sendBlockUpdate('block-a', 'block-a', 'hello');

    expect(socket.sent).toEqual([
      { type: 'focus', block_uuid: 'block-a' },
      { type: 'blur', block_uuid: 'block-a' },
      { type: 'block_update', block_uuid: 'block-a', block_id: 'block-a', name: 'hello' },
    ]);
  });

  it('sends typing, release, and request_lock messages', () => {
    manager.sendTyping('block-a');
    manager.sendRelease('block-a');
    manager.sendRequestLock('block-a');

    expect(socket.sent).toEqual([
      { type: 'typing', block_uuid: 'block-a' },
      { type: 'release', block_uuid: 'block-a' },
      { type: 'request_lock', block_uuid: 'block-a' },
    ]);
  });

  it('delivers incoming messages to listeners', () => {
    const listener = vi.fn();
    const unsub = manager.onMessage(listener);

    socket.onmessage?.({ data: JSON.stringify({ type: 'block_locked', block_uuid: 'block-a', user_id: 7 }) });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'block_locked', block_uuid: 'block-a', user_id: 7 }),
    );

    unsub();
  });

  it('queues messages when the socket is not open', () => {
    const disconnectedManager = new LiveSyncManager();
    disconnectedManager.sendFocus('block-a');

    expect((disconnectedManager as any).pendingMessages).toEqual([{ type: 'focus', block_uuid: 'block-a' }]);
  });

  it('reports connection status changes', () => {
    const freshManager = new LiveSyncManager();
    const statuses: string[] = [];
    freshManager.onStatusChange((status) => statuses.push(status));

    (freshManager as any)._setStatus('connected');

    expect(statuses).toContain('connected');
  });

  it('stops reconnecting and triggers auth redirect when the server closes with 4001', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const freshManager = new LiveSyncManager();
    const statuses: string[] = [];
    freshManager.onStatusChange((status) => statuses.push(status));

    (freshManager as any).workspaceUuid = 'ws-1';
    (freshManager as any)._open();
    const fakeSocket = (freshManager as any).ws as FakeWebSocket;

    fakeSocket.close(4001);

    expect(handleAuthFailure).toHaveBeenCalledTimes(1);
    expect(statuses).toContain('unauthorized');
    expect((freshManager as any).reconnectTimer).toBeNull();
    expect((freshManager as any).intentionalClose).toBe(true);

    vi.unstubAllGlobals();
  });
});
