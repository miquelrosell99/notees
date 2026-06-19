/**
 * LiveSyncManager — Singleton that manages the lightweight live-sync
 * WebSocket connection for a single page at a time.
 *
 * Provides imperative methods so Lexical plugins and mutation hooks can
 * send focus/blur/block-update events without prop-drilling.
 */



export interface LiveSyncUser {
  id: number;
  name: string;
  color: string;
}

export type LiveSyncMessage =
  | { type: 'user_focus'; block_uuid: string; user: LiveSyncUser }
  | { type: 'user_blur'; block_uuid: string; user_id: number }
  | { type: 'user_typing'; block_uuid: string; user: LiveSyncUser }
  | { type: 'block_locked'; block_uuid: string; user_id: number }
  | { type: 'block_lock_denied'; block_uuid: string; reason: string; queued?: boolean; locked_by?: LiveSyncUser }
  | { type: 'lock_granted'; block_uuid: string; user_id: number }
  | { type: 'block_lock_released'; block_uuid: string; user_id: number }
  | { type: 'lock_expired'; block_uuid: string; user_id: number }
  | { type: 'block_updated'; block_uuid: string; block_id: number; name: string; user_id: number }
  | { type: 'users_list'; users: Array<LiveSyncUser & { block_uuid: string }> };

type MessageListener = (msg: LiveSyncMessage) => void;
type StatusListener = (status: 'connected' | 'disconnected' | 'connecting' | 'error' | 'idle') => void;

export class LiveSyncManager {
  private ws: WebSocket | null = null;
  private nodeUuid: string | null = null;
  private listeners = new Set<MessageListener>();
  private statusListeners = new Set<StatusListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingMessages: object[] = [];
  private reconnectAttempts = 0;
  private intentionalClose = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private status: 'connected' | 'disconnected' | 'connecting' | 'error' | 'idle' = 'idle';

  /** Subscribe to incoming server messages. */
  onMessage(cb: MessageListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Subscribe to connection status changes. */
  onStatusChange(cb: StatusListener): () => void {
    this.statusListeners.add(cb);
    cb(this.status); // emit current status immediately
    return () => this.statusListeners.delete(cb);
  }

  private _setStatus(newStatus: typeof this.status): void {
    if (this.status === newStatus) return;
    this.status = newStatus;
    for (const cb of this.statusListeners) {
      try {
        cb(newStatus);
      } catch {
        // ignore
      }
    }
  }

  private _emit(msg: LiveSyncMessage): void {
    for (const cb of this.listeners) {
      try {
        cb(msg);
      } catch {
        // ignore
      }
    }
  }

  /** Open (or re-open) the WebSocket for a given page.
   *
   * The actual open is deferred briefly so that React Strict Mode / initial
   * render storms do not create visible connect/disconnect cycles in the
   * browser console.
   */
  connect(nodeUuid: string): void {
    if (this.nodeUuid === nodeUuid) {
      const state = this.ws?.readyState;
      if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
        return;
      }
    }
    this.disconnect();
    this.intentionalClose = false;
    this.nodeUuid = nodeUuid;
    this._setStatus('connecting');
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.nodeUuid === nodeUuid) this._open();
    }, 300);
  }

  /** Close the current connection. */
  disconnect(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.intentionalClose = true;
    if (this.ws) {
      const ws = this.ws;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.onopen = null;
      ws.close();
      this.ws = null;
    }
    this.nodeUuid = null;
    this.pendingMessages = [];
    this.reconnectAttempts = 0;
    this._setStatus('idle');
  }

  private _open(): void {
    if (this.ws) return;

    const nodeUuid = this.nodeUuid;
    if (!nodeUuid) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Optional VITE_WS_URL lets deployments bypass the Vite dev proxy and
    // connect directly to the backend WebSocket (e.g. ws://my-server:8000).
    // Authentication is provided by the HTTPOnly access_token cookie, which
    // is sent automatically for same-origin WebSocket handshakes.
    const configuredUrl = import.meta.env.VITE_WS_URL as string | undefined;
    const url = configuredUrl
      ? `${configuredUrl}/api/ws/live/${nodeUuid}`
      : `${protocol}//${window.location.host}/api/ws/live/${nodeUuid}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this._setStatus('connected');
      this.reconnectAttempts = 0;
      // Start heartbeat (must be shorter than the 8s server-side lock timeout)
      this.heartbeatTimer = setInterval(() => {
        this._send({ type: 'heartbeat' });
      }, 5000);
      // Flush any messages queued while connecting
      for (const msg of this.pendingMessages) {
        this._send(msg);
      }
      this.pendingMessages = [];
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as LiveSyncMessage;
        this._emit(msg);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      if (!this.intentionalClose) {
        this._setStatus('disconnected');
        this._scheduleReconnect();
      } else {
        this._setStatus('idle');
      }
    };

    ws.onerror = () => {
      this._setStatus('error');
      if (this.ws === ws) {
        ws.close();
      }
    };
  }

  private _scheduleReconnect(): void {
    if (this.reconnectTimer || !this.nodeUuid || this.ws) return;
    const delay = Math.min(30000, 1000 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.nodeUuid && !this.ws) this._open();
    }, delay);
  }

  private _send(payload: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    } else {
      this.pendingMessages.push(payload);
    }
  }

  /** Notify that the local user has focused a block. */
  sendFocus(blockUuid: string): void {
    this._send({ type: 'focus', block_uuid: blockUuid });
  }

  /** Notify that the local user has blurred a block. */
  sendBlur(blockUuid: string): void {
    this._send({ type: 'blur', block_uuid: blockUuid });
  }

  /** Broadcast a block content update to other clients. */
  sendBlockUpdate(blockUuid: string, blockId: number, name: string, _version?: number | null): void {
    this._send({ type: 'block_update', block_uuid: blockUuid, block_id: blockId, name });
  }

  /** Notify that the local user is typing in a block. */
  sendTyping(blockUuid: string): void {
    this._send({ type: 'typing', block_uuid: blockUuid });
  }

  /** Explicitly release a block lock early while keeping focus. */
  sendRelease(blockUuid: string): void {
    this._send({ type: 'release', block_uuid: blockUuid });
  }

  /** Request a lock for a block without changing local focus (queues if locked). */
  sendRequestLock(blockUuid: string): void {
    this._send({ type: 'request_lock', block_uuid: blockUuid });
  }
}

/** Global singleton. */
export const liveSyncManager = new LiveSyncManager();
