import { compareHlc } from './clock';
import type { OperationEnvelope } from './crypto';
import type { Hlc } from './clock';

export interface SnapshotEnvelope {
  snapshotId: string;
  workspaceId: string;
  hlc: Hlc;
  data: Uint8Array;
  restoreEpoch: number;
  hasSnapshot: boolean;
}

export interface SendBatchResult {
  savedIds: string[];
}

export interface Transport {
  send(envelope: OperationEnvelope): Promise<SendBatchResult> | SendBatchResult;
  sendBatch?(envelopes: OperationEnvelope[]): Promise<SendBatchResult> | SendBatchResult;
  catchUp(
    afterHlc: Hlc,
    onPage?: (page: OperationEnvelope[], totalSoFar: number, hasMore: boolean) => void
  ): OperationEnvelope[] | Promise<OperationEnvelope[]>;
  getLatestSnapshot(): Promise<SnapshotEnvelope>;
  uploadSnapshot?(snapshot: SnapshotEnvelope): Promise<void>;
  subscribe(callback: (envelope: OperationEnvelope) => void): void;
}

export class MemoryRelay {
  private envelopes = new Map<string, OperationEnvelope[]>();
  private subscribers = new Map<string, ((envelope: OperationEnvelope) => void)[]>();

  send(workspaceId: string, envelope: OperationEnvelope): void {
    const list = this.envelopes.get(workspaceId) ?? [];
    list.push(envelope);
    this.envelopes.set(workspaceId, list);
    const workspaceSubs = this.subscribers.get(workspaceId) ?? [];
    for (const cb of workspaceSubs) cb(envelope);
  }

  subscribe(workspaceId: string, callback: (envelope: OperationEnvelope) => void): void {
    const list = this.subscribers.get(workspaceId) ?? [];
    list.push(callback);
    this.subscribers.set(workspaceId, list);
  }

  catchUp(workspaceId: string, afterHlc: { physical: number; logical: number }): OperationEnvelope[] {
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

  send(envelope: OperationEnvelope): SendBatchResult {
    this.relay.send(this.workspaceId, envelope);
    return { savedIds: [envelope.id] };
  }

  sendBatch(envelopes: OperationEnvelope[]): SendBatchResult {
    for (const envelope of envelopes) {
      this.relay.send(this.workspaceId, envelope);
    }
    return { savedIds: envelopes.map((e) => e.id) };
  }

  catchUp(afterHlc: Hlc): OperationEnvelope[] {
    return this.relay.catchUp(this.workspaceId, afterHlc);
  }

  getLatestSnapshot(): Promise<SnapshotEnvelope> {
    return Promise.resolve({
      snapshotId: '',
      workspaceId: this.workspaceId,
      hlc: { physical: 0, logical: 0 },
      data: new Uint8Array(0),
      restoreEpoch: 0,
      hasSnapshot: false,
    });
  }

  subscribe(callback: (envelope: OperationEnvelope) => void): void {
    this.relay.subscribe(this.workspaceId, callback);
  }
}
