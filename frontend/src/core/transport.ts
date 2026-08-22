import type { OperationEnvelope } from './crypto';
import type { Hlc } from './clock';

export interface SnapshotEnvelope {
  snapshotId: string;
  workspaceId: string;
  hlc: Hlc;
  data: Uint8Array;
  restoreEpoch: number;
  hasSnapshot: boolean;
  /**
   * Highest server-assigned seq covered by the snapshot. Null only for
   * snapshots recorded before the seq cursor existed; clients resume catch-up
   * from seq 0 in that case (operation-id dedupe protects against replays).
   */
  upToSeq: number | null;
}

export interface SendBatchResult {
  savedIds: string[];
}

export interface CatchUpPage {
  envelopes: OperationEnvelope[];
  /** Seq of the last envelope when the page is full; null on the final page. */
  nextAfterSeq: number | null;
  hasMore: boolean;
}

export interface Transport {
  send(envelope: OperationEnvelope): Promise<SendBatchResult> | SendBatchResult;
  sendBatch?(envelopes: OperationEnvelope[]): Promise<SendBatchResult> | SendBatchResult;
  /**
   * Fetch one page of envelopes with a server-assigned seq greater than
   * `afterSeq` (0 for a cold start). The sync engine pages until `hasMore` is
   * false.
   */
  catchUp(afterSeq: number): CatchUpPage | Promise<CatchUpPage>;
  getLatestSnapshot(): Promise<SnapshotEnvelope>;
  uploadSnapshot?(snapshot: SnapshotEnvelope): Promise<void>;
  subscribe(callback: (envelope: OperationEnvelope) => void): void;
}

export class MemoryRelay {
  private envelopes = new Map<string, { envelope: OperationEnvelope; seq: number }[]>();
  private subscribers = new Map<string, ((envelope: OperationEnvelope) => void)[]>();
  private nextSeq = new Map<string, number>();

  send(workspaceId: string, envelope: OperationEnvelope): void {
    const list = this.envelopes.get(workspaceId) ?? [];
    const seq = (this.nextSeq.get(workspaceId) ?? 0) + 1;
    this.nextSeq.set(workspaceId, seq);
    list.push({ envelope, seq });
    this.envelopes.set(workspaceId, list);
    const workspaceSubs = this.subscribers.get(workspaceId) ?? [];
    for (const cb of workspaceSubs) cb(envelope);
  }

  subscribe(workspaceId: string, callback: (envelope: OperationEnvelope) => void): void {
    const list = this.subscribers.get(workspaceId) ?? [];
    list.push(callback);
    this.subscribers.set(workspaceId, list);
  }

  catchUp(workspaceId: string, afterSeq: number, limit = 10_000): CatchUpPage {
    const list = this.envelopes.get(workspaceId) ?? [];
    const page = list.filter((entry) => entry.seq > afterSeq).slice(0, limit);
    // Mirror the backend: the page is "full" when it hits the limit, and only
    // then is a next cursor returned.
    const hasMore = page.length === limit;
    return {
      envelopes: page.map((entry) => entry.envelope),
      nextAfterSeq: hasMore ? page[page.length - 1].seq : null,
      hasMore,
    };
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

  catchUp(afterSeq: number): CatchUpPage {
    return this.relay.catchUp(this.workspaceId, afterSeq);
  }

  getLatestSnapshot(): Promise<SnapshotEnvelope> {
    return Promise.resolve({
      snapshotId: '',
      workspaceId: this.workspaceId,
      hlc: { physical: 0, logical: 0 },
      data: new Uint8Array(0),
      restoreEpoch: 0,
      hasSnapshot: false,
      upToSeq: null,
    });
  }

  subscribe(callback: (envelope: OperationEnvelope) => void): void {
    this.relay.subscribe(this.workspaceId, callback);
  }
}
