import type { EncryptedEnvelope } from "./crypto";
import { compareHlc } from "./clock";

export class MemoryRelay {
  private envelopes = new Map<string, EncryptedEnvelope[]>();
  private subscribers = new Map<string, ((envelope: EncryptedEnvelope) => void)[]>();

  send(workspaceId: string, envelope: EncryptedEnvelope): void {
    const list = this.envelopes.get(workspaceId) ?? [];
    list.push(envelope);
    this.envelopes.set(workspaceId, list);
    const workspaceSubs = this.subscribers.get(workspaceId) ?? [];
    for (const cb of workspaceSubs) cb(envelope);
  }

  subscribe(workspaceId: string, callback: (envelope: EncryptedEnvelope) => void): void {
    const list = this.subscribers.get(workspaceId) ?? [];
    list.push(callback);
    this.subscribers.set(workspaceId, list);
  }

  catchUp(workspaceId: string, afterHlc: { physical: number; logical: number }): EncryptedEnvelope[] {
    const list = this.envelopes.get(workspaceId) ?? [];
    return list.filter((env) => compareHlc(env.hlc, afterHlc) > 0);
  }
}
