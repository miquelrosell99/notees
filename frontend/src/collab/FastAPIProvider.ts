/**
 * FastAPI WebSocket provider for Yjs collaboration.
 *
 * Implements the Provider interface required by @lexical/yjs CollaborationPlugin.
 */

import * as Y from 'yjs';
import type { Provider, ProviderAwareness, UserState } from '@lexical/yjs';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

const SYNC_STEP1 = 0;
const SYNC_STEP2 = 1;

type SyncCallback = (isSynced: boolean) => void;
type StatusCallback = (arg0: { status: string }) => void;
type UpdateCallback = (arg0: unknown) => void;
type ReloadCallback = (doc: Y.Doc) => void;

type ProviderCallback = SyncCallback | StatusCallback | UpdateCallback | ReloadCallback;

export class FastAPIProvider implements Provider {
  private ws: WebSocket | null = null;
  private ydoc: Y.Doc;
  private pageUuid: string;
  private token: string;
  private baseUrl: string;
  private _listeners: Map<string, Set<ProviderCallback>> = new Map();
  private _synced = false;

  awareness: ProviderAwareness;

  constructor(pageUuid: string, token: string, ydoc: Y.Doc) {
    this.pageUuid = pageUuid;
    this.token = token;
    this.ydoc = ydoc;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.baseUrl = `${protocol}//${window.location.host}`;

    // Minimal awareness implementation for Phase 3
    const awarenessStates = new Map<number, UserState>();
    let localState: UserState | null = null;
    const awarenessListeners = new Map<string, Set<() => void>>();

    this.awareness = {
      getLocalState: () => localState,
      getStates: () => new Map(awarenessStates),
      setLocalState: (state) => {
        localState = state as UserState | null;
        if (state) {
          awarenessStates.set(0, state as UserState);
        } else {
          awarenessStates.delete(0);
        }
        this._emitAwarenessUpdate();
      },
      setLocalStateField: (field, value) => {
        if (!localState) {
          localState = {
            anchorPos: null,
            color: '#2563eb',
            focusing: false,
            focusPos: null,
            name: 'User',
            awarenessData: {},
          };
        }
        localState[field as keyof UserState] = value as never;
        awarenessStates.set(0, localState);
        this._emitAwarenessUpdate();
      },
      on: (type, cb) => {
        if (!awarenessListeners.has(type)) awarenessListeners.set(type, new Set());
        awarenessListeners.get(type)!.add(cb as () => void);
      },
      off: (type, cb) => {
        awarenessListeners.get(type)?.delete(cb as () => void);
      },
    };

    this._emitAwarenessUpdate = () => {
      awarenessListeners.get('update')?.forEach((cb) => cb());
    };
  }

  private _emitAwarenessUpdate: () => void;

  connect(): void {
    if (this.ws) return;

    const url = `${this.baseUrl}/api/ws/collab/${this.pageUuid}?token=${encodeURIComponent(this.token)}`;
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this._emitStatus({ status: 'connecting' });
      const stateVector = Y.encodeStateVector(this.ydoc);
      this._sendSync(SYNC_STEP1, stateVector);
    };

    this.ws.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const data = new Uint8Array(event.data);
      if (data.length < 1) return;

      const msgType = data[0];
      const payload = data.slice(1);

      if (msgType === MSG_SYNC) {
        if (payload.length < 1) return;
        const syncType = payload[0];
        const syncPayload = payload.slice(1);

        if (syncType === SYNC_STEP1) {
          const diff = Y.encodeStateAsUpdate(this.ydoc, syncPayload);
          this._sendSync(SYNC_STEP2, diff);
          // After sending diff back, consider ourselves synced
          if (!this._synced) {
            this._synced = true;
            this._emitSync(true);
            this._emitStatus({ status: 'connected' });
          }
        } else if (syncType === SYNC_STEP2) {
          Y.applyUpdate(this.ydoc, syncPayload);
          if (!this._synced) {
            this._synced = true;
            this._emitSync(true);
            this._emitStatus({ status: 'connected' });
          }
        }
      } else if (msgType === MSG_AWARENESS) {
        // Awareness messages are broadcast via separate channel
        // For Phase 3, awareness is minimal
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      this._synced = false;
      this._emitStatus({ status: 'disconnected' });
    };

    this.ws.onerror = () => {
      this._emitStatus({ status: 'disconnected' });
    };
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._synced = false;
  }

  get isConnected(): boolean {
    return this._synced && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  on(type: 'sync', cb: SyncCallback): void;
  on(type: 'status', cb: StatusCallback): void;
  on(type: 'update', cb: UpdateCallback): void;
  on(type: 'reload', cb: ReloadCallback): void;
  on(type: string, cb: ProviderCallback): void {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type)!.add(cb);
  }

  off(type: 'sync', cb: SyncCallback): void;
  off(type: 'status', cb: StatusCallback): void;
  off(type: 'update', cb: UpdateCallback): void;
  off(type: 'reload', cb: ReloadCallback): void;
  off(type: string, cb: ProviderCallback): void {
    this._listeners.get(type)?.delete(cb);
  }

  private _emitSync(isSynced: boolean): void {
    this._listeners.get('sync')?.forEach((cb) => {
      try {
        (cb as SyncCallback)(isSynced);
      } catch {
        // ignore
      }
    });
  }

  private _emitStatus(arg0: { status: string }): void {
    this._listeners.get('status')?.forEach((cb) => {
      try {
        (cb as StatusCallback)(arg0);
      } catch {
        // ignore
      }
    });
  }

  private _sendSync(syncType: number, payload: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg = new Uint8Array(2 + payload.length);
    msg[0] = MSG_SYNC;
    msg[1] = syncType;
    msg.set(payload, 2);
    this.ws.send(msg);
  }
}
