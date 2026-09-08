/**
 * Tab RPC — BroadcastChannel bridge between the workspace leader tab and
 * follower tabs.
 *
 * The leader hosts the real worker-backed store client; followers hold a
 * RemoteStoreClient that implements IWorkspaceStoreClient by forwarding
 * calls to the leader. This gives every tab one SyncEngine and one SQLite
 * writer per workspace (see tabLeadership.ts): follower edits land in the
 * leader's store, the leader's sync engine pushes them, and notifications
 * flow back to all tabs.
 *
 * Channel protocol (per (workspaceId, actorId)):
 *   follower → leader: { kind: 'ping', tabId }
 *   leader → follower: { kind: 'hello' }                 (on start and on ping)
 *   follower → leader: { kind: 'call', tabId, id, callType, method, args }
 *   leader → follower: { kind: 'result', tabId, id, ok, result | error }
 *   leader → all:      { kind: 'event', message }        (notify/apply-progress)
 */

import type {
  ApplyProgressMessage,
  IWorkspaceStoreClient,
  NotifyChangeMessage,
} from './workerProtocol';
import { getLogger } from '@/utils/logger';

const log = getLogger('tabRpc');

const CALL_TIMEOUT_MS = 60_000;
const HELLO_TIMEOUT_MS = 15_000;

/** BroadcastChannel subset so tests can inject an in-memory hub. */
export interface ChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  close(): void;
}

export type ChannelFactory = (name: string) => ChannelLike;

function defaultChannelFactory(name: string): ChannelLike {
  return new BroadcastChannel(name) as unknown as ChannelLike;
}

export function tabChannelName(workspaceId: string, actorId: string): string {
  return `notees:workspace-tab-rpc:${workspaceId}:${actorId}`;
}

interface PingMessage {
  kind: 'ping';
  tabId: string;
}

interface HelloMessage {
  kind: 'hello';
}

interface CallMessage {
  kind: 'call';
  tabId: string;
  id: number;
  callType: 'query' | 'mutate' | 'export';
  method?: string;
  args?: unknown[];
}

interface ResultMessage {
  kind: 'result';
  tabId: string;
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface EventMessage {
  kind: 'event';
  message: NotifyChangeMessage | ApplyProgressMessage;
}

type TabRpcMessage = PingMessage | HelloMessage | CallMessage | ResultMessage | EventMessage;

let nextTabId = 1;
let nextCallId = 1;

// ─── Leader side ────────────────────────────────────────────────────────────

export interface TabRpcServer {
  close(): void;
}

/**
 * Serve follower-tab calls against the leader's real store client.
 * Notifications and apply-progress events from the worker are forwarded to
 * every follower tab.
 */
export function startTabRpcServer(
  client: IWorkspaceStoreClient,
  workspaceId: string,
  actorId: string,
  channelFactory: ChannelFactory = defaultChannelFactory
): TabRpcServer {
  const channel = channelFactory(tabChannelName(workspaceId, actorId));

  const post = (message: TabRpcMessage): void => {
    try {
      channel.postMessage(message);
    } catch (err) {
      log.warn('Failed to post tab RPC message', { error: String(err) });
    }
  };

  const onMessage = (event: MessageEvent): void => {
    const message = event.data as TabRpcMessage;
    if (message.kind === 'ping') {
      post({ kind: 'hello' });
      return;
    }
    if (message.kind !== 'call') return;

    void (async () => {
      try {
        let result: unknown;
        if (message.callType === 'query') {
          result = await client.query(message.method ?? '', message.args ?? []);
        } else if (message.callType === 'mutate') {
          result = await client.mutate(message.method ?? '', message.args ?? []);
        } else {
          result = await client.export();
        }
        post({ kind: 'result', tabId: message.tabId, id: message.id, ok: true, result });
      } catch (err) {
        post({
          kind: 'result',
          tabId: message.tabId,
          id: message.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  };
  channel.addEventListener('message', onMessage);

  const unsubscribeNotify = client.subscribe(null, (notification) => {
    post({
      kind: 'event',
      message: notification ?? { type: 'notify' },
    });
  });
  const unsubscribeProgress = client.subscribeProgress((applied, total) => {
    post({ kind: 'event', message: { type: 'apply-progress', applied, total } });
  });

  // Announce leadership so tabs that opened before the server was ready
  // discover it without a separate ping.
  post({ kind: 'hello' });

  return {
    close: () => {
      channel.removeEventListener('message', onMessage);
      unsubscribeNotify();
      unsubscribeProgress();
      channel.close();
    },
  };
}

// ─── Follower side ──────────────────────────────────────────────────────────

/**
 * IWorkspaceStoreClient proxy that forwards every call to the leader tab.
 * The leader owns persistence, and close() only detaches this tab.
 */
export class RemoteStoreClient implements IWorkspaceStoreClient {
  private channel: ChannelLike | null = null;
  private readonly channelFactory: ChannelFactory;
  private readonly tabId = `tab-${nextTabId++}-${Date.now()}`;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly listeners = new Map<
    string | null,
    Set<(notification?: NotifyChangeMessage) => void>
  >();
  private readonly progressListeners = new Set<(applied: number, total: number) => void>();
  private closed = false;

  constructor(channelFactory: ChannelFactory = defaultChannelFactory) {
    this.channelFactory = channelFactory;
  }

  async init(workspaceId: string, actorId: string): Promise<void> {
    const channel = this.channelFactory(tabChannelName(workspaceId, actorId));
    this.channel = channel;
    channel.addEventListener('message', (event) => this.handleMessage(event));

    // Wait for the leader to answer a ping (it may still be initializing).
    const deadline = Date.now() + HELLO_TIMEOUT_MS;
    for (;;) {
      const hello = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 1_000);
        const listener = (event: MessageEvent): void => {
          const message = event.data as TabRpcMessage;
          if (message.kind === 'hello') {
            clearTimeout(timer);
            channel.removeEventListener('message', listener);
            resolve(true);
          }
        };
        channel.addEventListener('message', listener);
      });
      channel.postMessage({ kind: 'ping', tabId: this.tabId } satisfies PingMessage);
      if (await hello) return;
      if (Date.now() > deadline) {
        throw new Error('Timed out waiting for the workspace leader tab');
      }
    }
  }

  private handleMessage(event: MessageEvent): void {
    const message = event.data as TabRpcMessage;
    if (message.kind === 'result' && message.tabId === this.tabId) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error ?? 'Leader tab call failed'));
      }
      return;
    }
    if (message.kind === 'event') {
      const inner = message.message;
      if (inner.type === 'apply-progress') {
        for (const cb of this.progressListeners) {
          try {
            cb(inner.applied, inner.total);
          } catch (err) {
            console.error('Workspace progress listener error:', err);
          }
        }
        return;
      }
      this.emit(inner.nodeId ?? null, inner);
    }
  }

  private emit(nodeId: string | null, notification: NotifyChangeMessage): void {
    const deliver = (callbacks: Set<(n?: NotifyChangeMessage) => void> | undefined): void => {
      if (!callbacks) return;
      for (const callback of callbacks) {
        try {
          callback(notification);
        } catch (err) {
          console.error('Workspace store listener error:', err);
        }
      }
    };
    deliver(this.listeners.get(nodeId));
    deliver(this.listeners.get(null));
  }

  private call<T>(callType: CallMessage['callType'], method?: string, args?: unknown[]): Promise<T> {
    const channel = this.channel;
    if (!channel || this.closed) {
      return Promise.reject(new Error('Remote store client is closed'));
    }
    const id = nextCallId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Leader tab ${callType} timed out (${method ?? callType})`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      channel.postMessage({
        kind: 'call',
        tabId: this.tabId,
        id,
        callType,
        method,
        args,
      } satisfies CallMessage);
    });
  }

  query<T>(method: string, args: unknown[]): Promise<T> {
    return this.call<T>('query', method, args);
  }

  mutate<T>(method: string, args: unknown[]): Promise<T> {
    return this.call<T>('mutate', method, args);
  }

  export(): Promise<Uint8Array> {
    return this.call<Uint8Array>('export');
  }

  subscribe(
    nodeId: string | null,
    callback: ((notification?: NotifyChangeMessage) => void) | (() => void)
  ): () => void {
    const cb = callback as (notification?: NotifyChangeMessage) => void;
    let set = this.listeners.get(nodeId);
    if (!set) {
      set = new Set();
      this.listeners.set(nodeId, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  subscribeProgress(callback: (applied: number, total: number) => void): () => void {
    this.progressListeners.add(callback);
    return () => {
      this.progressListeners.delete(callback);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Remote store client closed'));
    }
    this.pending.clear();
    this.channel?.close();
    this.channel = null;
    this.listeners.clear();
    this.progressListeners.clear();
  }

  isClosed(): boolean {
    return this.closed;
  }
}
