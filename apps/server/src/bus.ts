/**
 * WS subscription bus: workspace → socket set. The socket is an acceleration
 * path only (WIRE.md) — broadcast failures just prune the subscriber.
 */

import type { WebSocket } from "ws";

export class SubscriptionBus {
  private readonly subscribers = new Map<string, Set<WebSocket>>();

  subscribe(workspaceId: string, socket: WebSocket): void {
    let set = this.subscribers.get(workspaceId);
    if (set === undefined) {
      set = new Set();
      this.subscribers.set(workspaceId, set);
    }
    set.add(socket);
  }

  unsubscribe(workspaceId: string, socket: WebSocket): void {
    const set = this.subscribers.get(workspaceId);
    if (set === undefined) return;
    set.delete(socket);
    if (set.size === 0) this.subscribers.delete(workspaceId);
  }

  broadcast(workspaceId: string, message: string): void {
    const set = this.subscribers.get(workspaceId);
    if (set === undefined) return;
    for (const socket of set) {
      if (socket.readyState !== socket.OPEN) {
        set.delete(socket);
        continue;
      }
      try {
        socket.send(message);
      } catch {
        set.delete(socket);
      }
    }
    if (set.size === 0) this.subscribers.delete(workspaceId);
  }
}
