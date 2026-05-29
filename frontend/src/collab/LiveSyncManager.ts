/**
 * LiveSyncManager — Singleton that manages the lightweight live-sync
 * WebSocket connection for a single page at a time.
 *
 * Provides imperative methods so Lexical plugins and mutation hooks can
 * send focus/blur/block-update events without prop-drilling.
 */

import { useAuthStore } from '@/stores/authStore';

export interface LiveSyncUser {
  id: number;
  name: string;
  color: string;
}

export type LiveSyncMessage =
  | { type: 'user_focus'; block_uuid: string; user: LiveSyncUser }
  | { type: 'user_blur'; block_uuid: string; user_id: number }
  | { type: 'block_updated'; block_uuid: string; block_id: number; name: string; version: number | null; user_id: number }
  | { type: 'users_list'; users: Array<LiveSyncUser & { block_uuid: string }> };

type MessageListener = (msg: LiveSyncMessage) => void;

class LiveSyncManager {
  private ws: WebSocket | null = null;
  private pageUuid: string | null = null;
  private listeners = new Set<MessageListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingMessages: object[] = [];
  private reconnectAttempts = 0;
  private intentionalClose = false;

  /** Subscribe to incoming server messages. */
  onMessage(cb: MessageListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
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

  /** Open (or re-open) the WebSocket for a given page. */
  connect(pageUuid: string): void {
    if (this.pageUuid === pageUuid) {
      const state = this.ws?.readyState;
      if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
        return;
      }
    }
    this.disconnect();
    this.intentionalClose = false;
    this.pageUuid = pageUuid;
    this._open();
  }

  /** Close the current connection. */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
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
    this.pageUuid = null;
    this.pendingMessages = [];
    this.reconnectAttempts = 0;
  }

  private _open(): void {
    if (this.ws) return;

    const pageUuid = this.pageUuid;
    if (!pageUuid) return;

    const token = useAuthStore.getState().token;
    if (!token) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/api/ws/live/${pageUuid}?token=${encodeURIComponent(token)}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
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
      if (!this.intentionalClose) {
        this._scheduleReconnect();
      }
    };

    ws.onerror = () => {
      if (this.ws === ws) {
        ws.close();
      }
    };
  }

  private _scheduleReconnect(): void {
    if (this.reconnectTimer || !this.pageUuid || this.ws) return;
    const delay = Math.min(30000, 1000 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.pageUuid && !this.ws) this._open();
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
  sendBlockUpdate(blockUuid: string, blockId: number, name: string, version?: number | null): void {
    this._send({ type: 'block_update', block_uuid: blockUuid, block_id: blockId, name, version: version ?? null });
  }
}

/** Global singleton. */
export const liveSyncManager = new LiveSyncManager();
