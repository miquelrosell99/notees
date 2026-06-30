/**
 * Yjs Provider adapter that ships local updates over the live-sync WebSocket.
 *
 * Lexical's collaboration hooks require a Provider implementation for status,
 * sync signals, and awareness. This provider does not open its own connection;
 * it re-uses the shared `liveSyncManager` WebSocket and forwards Yjs document
 * updates as `yjs_update` messages.
 */

import type { Provider, ProviderAwareness, UserState } from '@lexical/yjs';
import type { Doc } from 'yjs';
import { liveSyncManager } from '@/features/collab';

type SyncListener = (isSynced: boolean) => void;
type StatusListener = (payload: { status: string }) => void;
type UpdateListener = (payload: unknown) => void;
type ReloadListener = (doc: Doc) => void;

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

class LiveSyncYjsAwareness implements ProviderAwareness {
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
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        // Ignore awareness subscriber errors.
      }
    }
  }
}

export class LiveSyncYjsProvider implements Provider {
  awareness = new LiveSyncYjsAwareness();

  private doc: Doc;
  private blockUuid: string;
  private syncListeners = new Set<SyncListener>();
  private statusListeners = new Set<StatusListener>();
  private updateListeners = new Set<UpdateListener>();
  private reloadListeners = new Set<ReloadListener>();
  private connected = false;
  private docUpdateHandler: ((update: Uint8Array, origin: unknown) => void) | null = null;

  constructor(doc: Doc, blockUuid: string) {
    this.doc = doc;
    this.blockUuid = blockUuid;
    this.docUpdateHandler = (update: Uint8Array, origin: unknown) => {
      // Updates marked as remote come from the WebSocket and must not be echoed.
      if (origin === 'remote') return;
      liveSyncManager.sendMessage({
        type: 'yjs_update',
        node_uuid: this.blockUuid,
        update_blob: uint8ArrayToBase64(update),
      });
    };
    doc.on('update', this.docUpdateHandler);
  }

  connect(): void {
    if (this.connected) return;
    this.connected = true;
    queueMicrotask(() => {
      for (const cb of this.statusListeners) cb({ status: 'connected' });
      for (const cb of this.syncListeners) cb(true);
    });
  }

  disconnect(): void {
    this.connected = false;
    for (const cb of this.statusListeners) cb({ status: 'disconnected' });
    if (this.docUpdateHandler) {
      this.doc.off('update', this.docUpdateHandler);
      this.docUpdateHandler = null;
    }
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
}
