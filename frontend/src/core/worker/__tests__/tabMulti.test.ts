import { describe, it, expect, beforeEach, vi } from 'vitest';
import { electWorkspaceTab } from '../tabLeadership';
import {
  RemoteStoreClient,
  startTabRpcServer,
  tabChannelName,
  type ChannelLike,
} from '../tabRpc';
import { createWorkspaceStoreClient } from '../WorkspaceStoreClient';
import { WorkspaceStore } from '../../store';
import { uuidv7 } from '../../uuid';
import { createTestDatabase } from '../../../core/__tests__/helpers';

// ─── Fake Web Locks ─────────────────────────────────────────────────────────

interface FakeLock {
  mode: string;
  name: string;
}

class FakeLockManager {
  private held = false;
  private queued: Array<() => void> = [];

  async request(
    name: string,
    options: { mode: 'exclusive'; ifAvailable?: boolean },
    callback: (lock: FakeLock | null) => unknown
  ): Promise<unknown> {
    if (options.ifAvailable && this.held) {
      return callback(null);
    }
    if (this.held) {
      return new Promise((resolve) => {
        this.queued.push(() => resolve(this.grant(name, callback)));
      });
    }
    return this.grant(name, callback);
  }

  private async grant(
    name: string,
    callback: (lock: FakeLock | null) => unknown
  ): Promise<unknown> {
    this.held = true;
    const result = await callback({ mode: 'exclusive', name });
    this.held = false;
    this.queued.shift()?.();
    return result;
  }
}

// ─── Fake BroadcastChannel hub ──────────────────────────────────────────────

class FakeChannel implements ChannelLike {
  private static hubs = new Map<string, Set<FakeChannel>>();
  private readonly listeners = new Set<(event: MessageEvent) => void>();

  static reset(): void {
    FakeChannel.hubs = new Map();
  }

  constructor(private readonly name: string) {
    const set = FakeChannel.hubs.get(name) ?? new Set();
    set.add(this);
    FakeChannel.hubs.set(name, set);
  }

  postMessage(message: unknown): void {
    for (const channel of FakeChannel.hubs.get(this.name) ?? []) {
      if (channel !== this) channel.deliver(message);
    }
  }

  private deliver(message: unknown): void {
    for (const listener of this.listeners) {
      listener({ data: message } as MessageEvent);
    }
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.delete(listener);
  }

  close(): void {
    FakeChannel.hubs.get(this.name)?.delete(this);
  }
}

const fakeChannelFactory = (name: string): ChannelLike => new FakeChannel(name);

// ─── Election ───────────────────────────────────────────────────────────────

describe('electWorkspaceTab', () => {
  beforeEach(() => {
    FakeChannel.reset();
  });

  it('elects the first tab leader and the second follower; takeover fires on release', async () => {
    const locks = new FakeLockManager();
    Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });

    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const takeover = vi.fn();

    const first = await electWorkspaceTab(workspaceId, actorId, vi.fn());
    expect(first.role).toBe('leader');

    const second = await electWorkspaceTab(workspaceId, actorId, takeover);
    expect(second.role).toBe('follower');
    expect(takeover).not.toHaveBeenCalled();

    // Leader releases (or its tab closes): the queued follower is granted.
    first.release();
    await vi.waitFor(() => {
      expect(takeover).toHaveBeenCalledOnce();
    });

    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
  });
});

// ─── RPC bridge ─────────────────────────────────────────────────────────────

describe('tab RPC (leader server + follower RemoteStoreClient)', () => {
  beforeEach(() => {
    FakeChannel.reset();
  });

  async function createLeader() {
    const db = await createTestDatabase();
    const store = new WorkspaceStore(db, 'ws-1', 'actor-1');
    const client = createWorkspaceStoreClient();
    await client.init('ws-1', 'actor-1', { store });
    const server = startTabRpcServer(client, 'ws-1', 'actor-1', fakeChannelFactory);
    return { store, client, server };
  }

  it('forwards mutations and queries to the leader store', async () => {
    const { store, server } = await createLeader();
    const remote = new RemoteStoreClient(fakeChannelFactory);
    await remote.init('ws-1', 'actor-1');

    const nodeId = uuidv7();
    await remote.mutate('createNode', [{ nodeId, kind: 'page', parentId: null }]);

    // Visible both through the remote client and in the leader's own store.
    const viaRemote = await remote.query<{ id: string } | null>('getNode', [nodeId]);
    expect(viaRemote?.id).toBe(nodeId);
    expect(store.getNode(nodeId)).toBeDefined();

    server.close();
    remote.close();
  });

  it('delivers leader notifications to follower subscribers', async () => {
    const { client, server } = await createLeader();
    const remote = new RemoteStoreClient(fakeChannelFactory);
    await remote.init('ws-1', 'actor-1');

    const notifications: string[] = [];
    remote.subscribe(null, (n) => notifications.push(n?.scope ?? 'unknown'));

    const nodeId = uuidv7();
    await client.mutate('createNode', [{ nodeId, kind: 'page', parentId: null }]);

    await vi.waitFor(() => {
      expect(notifications.length).toBeGreaterThan(0);
    });

    server.close();
    remote.close();
  });

  it('rejects in-flight calls when the follower closes', async () => {
    const { server } = await createLeader();
    const remote = new RemoteStoreClient(fakeChannelFactory);
    await remote.init('ws-1', 'actor-1');

    remote.close();
    await expect(remote.query('getNode', ['x'])).rejects.toThrow('closed');
    expect(remote.isClosed()).toBe(true);

    server.close();
  });

  it('uses a per-(workspace, actor) channel', () => {
    expect(tabChannelName('ws-1', 'a')).not.toBe(tabChannelName('ws-1', 'b'));
    expect(tabChannelName('ws-1', 'a')).not.toBe(tabChannelName('ws-2', 'a'));
  });
});
