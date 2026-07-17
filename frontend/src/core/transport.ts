import { compareHlc } from './clock';
import type { EncryptedEnvelope } from './crypto';
import type { Hlc } from './clock';

export interface Transport {
  send(envelope: EncryptedEnvelope): Promise<void> | void;
  catchUp(afterHlc: Hlc): EncryptedEnvelope[] | Promise<EncryptedEnvelope[]>;
  subscribe(callback: (envelope: EncryptedEnvelope) => void): void;
}

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

export class MemoryTransport implements Transport {
  private relay: MemoryRelay;
  private workspaceId: string;

  constructor(relay: MemoryRelay, workspaceId: string) {
    this.relay = relay;
    this.workspaceId = workspaceId;
  }

  send(envelope: EncryptedEnvelope): void {
    this.relay.send(this.workspaceId, envelope);
  }

  catchUp(afterHlc: Hlc): EncryptedEnvelope[] {
    return this.relay.catchUp(this.workspaceId, afterHlc);
  }

  subscribe(callback: (envelope: EncryptedEnvelope) => void): void {
    this.relay.subscribe(this.workspaceId, callback);
  }
}
