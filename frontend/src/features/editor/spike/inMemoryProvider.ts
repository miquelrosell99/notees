/**
 * In-memory Yjs provider for local CRDT spike tests.
 *
 * Does not send data over the network; instead it relies on two (or more)
 * editors sharing the same `Y.Doc`. The provider only fulfills the
 * `Provider` / `ProviderAwareness` contract that Lexical's collaboration
 * plugin expects (sync signal, status, awareness).
 */

import type { Provider, ProviderAwareness, UserState } from '@lexical/yjs';
import type { Doc } from 'yjs';

type SyncListener = (isSynced: boolean) => void;
type StatusListener = (payload: { status: string }) => void;
type UpdateListener = (payload: unknown) => void;
type ReloadListener = (doc: Doc) => void;

class InMemoryAwareness implements ProviderAwareness {
  private states = new Map<number, UserState>();
  private listeners = new Set<() => void>();
  private localState: UserState | null = null;

  setLocalState(state: UserState | null): void {
    this.localState = state;
    if (state) {
      this.states.set(0, state);
    } else {
      this.states.delete(0);
    }
    this.emit();
  }

  setLocalStateField(field: string, value: unknown): void {
    if (!this.localState) {
      this.localState = {
        anchorPos: null,
        color: '',
        focusing: false,
        focusPos: null,
        name: '',
        awarenessData: {},
      };
    }
    (this.localState as Record<string, unknown>)[field] = value;
    this.setLocalState(this.localState);
  }

  getLocalState(): UserState | null {
    return this.localState;
  }

  getStates(): Map<number, UserState> {
    return this.states;
  }

  on(type: 'update', cb: () => void): void {
    if (type === 'update') this.listeners.add(cb);
  }

  off(type: 'update', cb: () => void): void {
    if (type === 'update') this.listeners.delete(cb);
  }

  private emit(): void {
    this.listeners.forEach((cb) => cb());
  }
}

export class InMemoryProvider implements Provider {
  awareness = new InMemoryAwareness();

  private syncListeners = new Set<SyncListener>();
  private statusListeners = new Set<StatusListener>();
  private updateListeners = new Set<UpdateListener>();
  private reloadListeners = new Set<ReloadListener>();
  private connected = false;

  connect(): void {
    if (this.connected) return;
    this.connected = true;
    queueMicrotask(() => {
      this.statusListeners.forEach((cb) => cb({ status: 'connected' }));
      this.syncListeners.forEach((cb) => cb(true));
    });
  }

  disconnect(): void {
    this.connected = false;
    this.statusListeners.forEach((cb) => cb({ status: 'disconnected' }));
  }

  on(type: 'sync', cb: SyncListener): void;
  on(type: 'status', cb: StatusListener): void;
  on(type: 'update', cb: UpdateListener): void;
  on(type: 'reload', cb: ReloadListener): void;
  on(type: string, cb: SyncListener | StatusListener | UpdateListener | ReloadListener): void {
    switch (type) {
      case 'sync':
        this.syncListeners.add(cb as SyncListener);
        break;
      case 'status':
        this.statusListeners.add(cb as StatusListener);
        break;
      case 'update':
        this.updateListeners.add(cb as UpdateListener);
        break;
      case 'reload':
        this.reloadListeners.add(cb as ReloadListener);
        break;
    }
  }

  off(type: 'sync', cb: SyncListener): void;
  off(type: 'status', cb: StatusListener): void;
  off(type: 'update', cb: UpdateListener): void;
  off(type: 'reload', cb: ReloadListener): void;
  off(type: string, cb: SyncListener | StatusListener | UpdateListener | ReloadListener): void {
    switch (type) {
      case 'sync':
        this.syncListeners.delete(cb as SyncListener);
        break;
      case 'status':
        this.statusListeners.delete(cb as StatusListener);
        break;
      case 'update':
        this.updateListeners.delete(cb as UpdateListener);
        break;
      case 'reload':
        this.reloadListeners.delete(cb as ReloadListener);
        break;
    }
  }

  emitUpdate(payload: unknown): void {
    this.updateListeners.forEach((cb) => cb(payload));
  }
}
