import { describe, it, expect, vi } from 'vitest';
import { CURRENT_DERIVED_STATE_VERSION, WorkspaceStore } from '../store';
import { SyncEngine } from '../sync';
import { MemoryRelay, MemoryTransport } from '../transport';
import { uuidv7 } from '../uuid';
import { createTestDatabase } from './helpers';
import { createWorkspaceStoreClient } from '../worker/WorkspaceStoreClient';
import type { IWorkspaceStoreClient } from '../worker/workerProtocol';

async function createClientFromStore(store: WorkspaceStore): Promise<IWorkspaceStoreClient> {
  const client = createWorkspaceStoreClient();
  await client.init(store.getWorkspaceId(), store.getActorId(), { store });
  return client;
}

describe('SyncEngine', () => {
  it('only pushes operations newer than the last push watermark', async () => {
    const workspaceId = uuidv7();
    const actorA = uuidv7();
    const relay = new MemoryRelay();
    const transport = new MemoryTransport(relay, workspaceId);

    const dbA = await createTestDatabase();
    const storeA = new WorkspaceStore(dbA, workspaceId, actorA);
    const clientA = await createClientFromStore(storeA);
    const syncA = new SyncEngine(clientA, transport);

    const nodeId = uuidv7();
    storeA.createNode({ nodeId, kind: 'page', parentId: null });

    await syncA.push();
    expect(relay.catchUp(workspaceId, 0).envelopes).toHaveLength(1);

    // A second push with no new operations should not send anything.
    await syncA.push();
    expect(relay.catchUp(workspaceId, 0).envelopes).toHaveLength(1);

    // A new operation should be pushed.
    storeA.updateText(nodeId, (text) => text.insert(0, 'hello'));
    await syncA.push();
    expect(relay.catchUp(workspaceId, 0).envelopes).toHaveLength(2);
  });

  it('converges two workspace stores via in-memory transport', async () => {
    const workspaceId = uuidv7();
    const actorA = uuidv7();
    const actorB = uuidv7();
    const relay = new MemoryRelay();

    const dbA = await createTestDatabase();
    const dbB = await createTestDatabase();
    const storeA = new WorkspaceStore(dbA, workspaceId, actorA);
    const storeB = new WorkspaceStore(dbB, workspaceId, actorB);
    const clientA = await createClientFromStore(storeA);
    const clientB = await createClientFromStore(storeB);
    const syncA = new SyncEngine(clientA, new MemoryTransport(relay, workspaceId));
    const syncB = new SyncEngine(clientB, new MemoryTransport(relay, workspaceId));

    const nodeId = uuidv7();
    storeA.createNode({ nodeId, kind: 'page', parentId: null });
    storeA.updateText(nodeId, (text) => text.insert(0, 'Hello from A'));

    await syncA.push();
    await syncB.pull();

    const nodeB = storeB.getNode(nodeId);
    expect(nodeB).toBeDefined();
    const contentB = JSON.parse(nodeB!.content);
    expect(contentB[0].text).toBe('Hello from A');

    storeB.updateText(nodeId, (text) => text.insert(text.toPlaintext().length, ' + Hello from B'));
    await syncB.push();
    await syncA.pull();

    const nodeA = storeA.getNode(nodeId);
    const contentA = JSON.parse(nodeA!.content);
    expect(contentA[0].text).toContain('Hello from A');
    expect(contentA[0].text).toContain('Hello from B');
  });

  it('rebuilds derived state from operations and ignores stale snapshots when applier version changes', async () => {
    const workspaceId = uuidv7();
    const actor = uuidv7();
    const relay = new MemoryRelay();

    const dbA = await createTestDatabase();
    const storeA = new WorkspaceStore(dbA, workspaceId, actor);
    const clientA = await createClientFromStore(storeA);
    const syncA = new SyncEngine(clientA, new MemoryTransport(relay, workspaceId));

    const nodeId = uuidv7();
    storeA.createNode({ nodeId, kind: 'page', parentId: null });
    storeA.updateText(nodeId, (text) => text.insert(0, 'hello'));
    await syncA.push();

    // Snapshot taken here is tagged with a future HLC. A client that trusts it
    // would set its watermark past all real operations and never catch up.
    const snapshot = storeA.exportSnapshot({ physical: 9_999_999_999_999, logical: 0 });

    // Server state advances after the snapshot.
    storeA.updateText(nodeId, (text) => {
      text.delete(0, text.toPlaintext().length);
      text.insert(0, 'world');
    });
    await syncA.push();

    // Client opens with stale applier version and the stale snapshot.
    const dbB = await createTestDatabase();
    const storeB = new WorkspaceStore(dbB, workspaceId, actor);
    storeB.setDerivedStateVersion(0);

    const transportB = new MemoryTransport(relay, workspaceId);
    transportB.getLatestSnapshot = async () => ({
      snapshotId: 'snap-1',
      workspaceId,
      hlc: snapshot.hlc,
      data: snapshot.data,
      restoreEpoch: 0,
      hasSnapshot: true,
      upToSeq: null,
    });

    const clientB = await createClientFromStore(storeB);
    const syncB = new SyncEngine(clientB, transportB);
    await syncB.initialize();

    // Hard rebuild ignores the snapshot and replays the full operation log.
    const nodeB = storeB.getNode(nodeId);
    expect(nodeB).toBeDefined();
    const contentB = JSON.parse(nodeB!.content);
    expect(contentB[0].text).toBe('world');
    expect(storeB.getDerivedStateVersion()).toBe(CURRENT_DERIVED_STATE_VERSION);
  });

  it('reports cumulative sent counts during push', async () => {
    const workspaceId = uuidv7();
    const actorA = uuidv7();
    const relay = new MemoryRelay();
    const transport = new MemoryTransport(relay, workspaceId);

    const dbA = await createTestDatabase();
    const storeA = new WorkspaceStore(dbA, workspaceId, actorA);
    const clientA = await createClientFromStore(storeA);
    const syncA = new SyncEngine(clientA, transport);

    // 150 ops → two send chunks (SEND_BATCH_SIZE = 100).
    for (let i = 0; i < 150; i++) {
      storeA.createNode({ nodeId: uuidv7(), kind: 'block', parentId: null });
    }

    const progressReports: Array<{ sent: number; total: number }> = [];
    await syncA.push((p) => progressReports.push({ ...p }));

    expect(progressReports).toEqual([
      { sent: 100, total: 150 },
      { sent: 150, total: 150 },
    ]);
  });

  it('advances the push watermark when the server already has the operations (duplicate-only batches)', async () => {
    const workspaceId = uuidv7();
    const actor = uuidv7();
    const relay = new MemoryRelay();

    const db = await createTestDatabase();
    const store = new WorkspaceStore(db, workspaceId, actor);
    const client = await createClientFromStore(store);
    const sync = new SyncEngine(client, new MemoryTransport(relay, workspaceId));

    const nodeId = uuidv7();
    store.createNode({ nodeId, kind: 'page', parentId: null });
    await sync.push();
    expect(relay.catchUp(workspaceId, 0).envelopes).toHaveLength(1);

    // Simulate interrupted-rebuild corruption: the operation log still holds
    // server-known ops, but the outbox and push watermark were reset.
    store.getDb().run("UPDATE sync_outbox SET state = 'pending'");
    await client.mutate('saveWatermark', ['pushed', { physical: 0, logical: 0 }]);

    // The real server omits duplicates from saved_ids (app/relay/storage.py).
    const seen = new Set(relay.catchUp(workspaceId, 0).envelopes.map((e) => e.id));
    const serverLikeTransport = new MemoryTransport(relay, workspaceId);
    serverLikeTransport.sendBatch = (envelopes) => ({
      savedIds: envelopes.filter((e) => !seen.has(e.id)).map((e) => e.id),
    });
    const sync2 = new SyncEngine(client, serverLikeTransport);

    // With the bug this push never resolves: duplicate-only chunks ack nothing,
    // the watermark never advances, and the same ops are re-sent forever.
    await Promise.race([
      sync2.push(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('push hung')), 3000)),
    ]);

    const pending = store.getPendingPushOperations({ physical: 0, logical: 0 }, 1000, Date.now());
    expect(pending).toHaveLength(0);
  });

  it('retries failed operations and only advances watermark on ack', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const workspaceId = uuidv7();
    const actor = uuidv7();
    const relay = new MemoryRelay();

    const db = await createTestDatabase();
    const store = new WorkspaceStore(db, workspaceId, actor);
    const client = await createClientFromStore(store);

    let shouldFail = true;
    const transport = new MemoryTransport(relay, workspaceId);
    const originalSendBatch = transport.sendBatch.bind(transport);
    transport.sendBatch = (envelopes) => {
      if (shouldFail) {
        throw new Error('network error');
      }
      return originalSendBatch(envelopes);
    };

    const sync = new SyncEngine(client, transport);

    const nodeId = uuidv7();
    store.createNode({ nodeId, kind: 'page', parentId: null });

    await expect(sync.push()).rejects.toThrow('network error');
    expect(relay.catchUp(workspaceId, 0).envelopes).toHaveLength(0);

    const watermarksAfterFailure = await client.query<{ pushed: { physical: number; logical: number } }>(
      'loadWatermarks',
      []
    );
    expect(watermarksAfterFailure.pushed).toEqual({ physical: 0, logical: 0 });

    shouldFail = false;
    vi.advanceTimersByTime(6000);
    await sync.push();

    expect(relay.catchUp(workspaceId, 0).envelopes).toHaveLength(1);

    const watermarksAfterSuccess = await client.query<{ pushed: { physical: number; logical: number } }>(
      'loadWatermarks',
      []
    );
    expect(watermarksAfterSuccess.pushed.physical).toBeGreaterThan(0);

    vi.useRealTimers();
  });

  it('shares a single in-flight promise across concurrent syncOnce calls', async () => {
    const workspaceId = uuidv7();
    const actor = uuidv7();
    const relay = new MemoryRelay();
    const transport = new MemoryTransport(relay, workspaceId);

    const db = await createTestDatabase();
    const store = new WorkspaceStore(db, workspaceId, actor);
    const client = await createClientFromStore(store);
    const sync = new SyncEngine(client, transport);

    const pushSpy = vi.spyOn(sync, 'push').mockResolvedValue();
    const pullSpy = vi.spyOn(sync, 'pull').mockResolvedValue();

    const statusChanges: string[] = [];
    sync.subscribeStatus((status) => statusChanges.push(status));

    const promiseA = sync.syncOnce();
    const promiseB = sync.syncOnce();

    expect(promiseA).toBe(promiseB);

    await Promise.all([promiseA, promiseB]);

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pullSpy).toHaveBeenCalledTimes(1);
    expect(statusChanges).toEqual(['idle', 'syncing', 'idle']);
  });

  it('does not flush IndexedDB when pull applies no envelopes', async () => {
    const workspaceId = uuidv7();
    const actor = uuidv7();
    const relay = new MemoryRelay();

    const db = await createTestDatabase();
    const store = new WorkspaceStore(db, workspaceId, actor);
    const client = await createClientFromStore(store);
    const mutateSpy = vi.spyOn(client, 'mutate');

    const transport = new MemoryTransport(relay, workspaceId);
    const sync = new SyncEngine(client, transport);

    await sync.pull();

    expect(mutateSpy).not.toHaveBeenCalledWith('persistNow', []);
  });

  it('pages catch-up by seq cursor and resumes from the stored cursor', async () => {
    const workspaceId = uuidv7();
    const actorA = uuidv7();
    const actorB = uuidv7();
    const relay = new MemoryRelay();

    const dbA = await createTestDatabase();
    const storeA = new WorkspaceStore(dbA, workspaceId, actorA);
    const clientA = await createClientFromStore(storeA);
    const syncA = new SyncEngine(clientA, new MemoryTransport(relay, workspaceId));

    const nodeIds = [uuidv7(), uuidv7(), uuidv7()];
    for (const nodeId of nodeIds) {
      storeA.createNode({ nodeId, kind: 'page', parentId: null });
    }
    await syncA.push();

    // Force small pages so pull has to paginate by seq.
    const transportB = new MemoryTransport(relay, workspaceId);
    const catchUpArgs: number[] = [];
    transportB.catchUp = (afterSeq: number) => {
      catchUpArgs.push(afterSeq);
      return relay.catchUp(workspaceId, afterSeq, 2);
    };

    const dbB = await createTestDatabase();
    const storeB = new WorkspaceStore(dbB, workspaceId, actorB);
    const clientB = await createClientFromStore(storeB);
    const syncB = new SyncEngine(clientB, transportB);

    await syncB.pull();

    // Page 1: afterSeq 0 -> seqs 1,2 (full page, hasMore). Page 2: afterSeq 2
    // -> seq 3 (partial final page, no next cursor).
    expect(catchUpArgs).toEqual([0, 2]);
    for (const nodeId of nodeIds) {
      expect(storeB.getNode(nodeId)).toBeDefined();
    }

    const watermarks = await clientB.query<{ receivedSeq: number }>('loadWatermarks', []);
    // The final page carries no next cursor, so the adopted cursor is the last
    // next_after_seq seen; the tail page is re-fetched (dedupe-protected) on
    // the next pull.
    expect(watermarks.receivedSeq).toBe(2);

    catchUpArgs.length = 0;
    await syncB.pull();
    expect(catchUpArgs[0]).toBe(2);
  });

  it('resumes catch-up from a restored snapshot upToSeq', async () => {
    const workspaceId = uuidv7();
    const actorA = uuidv7();
    const actorB = uuidv7();
    const relay = new MemoryRelay();

    const dbA = await createTestDatabase();
    const storeA = new WorkspaceStore(dbA, workspaceId, actorA);
    const clientA = await createClientFromStore(storeA);
    const syncA = new SyncEngine(clientA, new MemoryTransport(relay, workspaceId));

    const nodeId1 = uuidv7();
    const nodeId2 = uuidv7();
    storeA.createNode({ nodeId: nodeId1, kind: 'page', parentId: null });
    storeA.createNode({ nodeId: nodeId2, kind: 'page', parentId: null });
    await syncA.push();

    // Snapshot covers seqs 1-2.
    const snapshot = storeA.exportSnapshot();

    // Server state advances past the snapshot (seq 3).
    const nodeId3 = uuidv7();
    storeA.createNode({ nodeId: nodeId3, kind: 'page', parentId: null });
    await syncA.push();

    const transportB = new MemoryTransport(relay, workspaceId);
    transportB.getLatestSnapshot = async () => ({
      snapshotId: 'snap-1',
      workspaceId,
      hlc: snapshot.hlc,
      data: snapshot.data,
      restoreEpoch: 0,
      hasSnapshot: true,
      upToSeq: 2,
    });
    const catchUpArgs: number[] = [];
    const baseCatchUp = transportB.catchUp.bind(transportB);
    transportB.catchUp = (afterSeq: number) => {
      catchUpArgs.push(afterSeq);
      return baseCatchUp(afterSeq);
    };

    const dbB = await createTestDatabase();
    const storeB = new WorkspaceStore(dbB, workspaceId, actorB);
    const clientB = await createClientFromStore(storeB);
    const syncB = new SyncEngine(clientB, transportB);

    await syncB.pull();

    // Catch-up resumes from the snapshot's upToSeq, not from 0.
    expect(catchUpArgs).toEqual([2]);
    expect(storeB.getNode(nodeId1)).toBeDefined();
    expect(storeB.getNode(nodeId2)).toBeDefined();
    expect(storeB.getNode(nodeId3)).toBeDefined();
  });

  it('does not fetch snapshot data when the server snapshot is not newer', async () => {
    const workspaceId = uuidv7();
    const actor = uuidv7();
    const relay = new MemoryRelay();

    const db = await createTestDatabase();
    const store = new WorkspaceStore(db, workspaceId, actor);
    const client = await createClientFromStore(store);

    const snapshotCalls: Array<{ includeData?: boolean } | undefined> = [];
    const transport = new MemoryTransport(relay, workspaceId);
    transport.getLatestSnapshot = async (options?: { includeData?: boolean }) => {
      snapshotCalls.push(options);
      return {
        snapshotId: 'snap-1',
        workspaceId,
        // HLC (0,0) is never newer than the local watermark, so the payload
        // must never be requested.
        hlc: { physical: 0, logical: 0 },
        data: new Uint8Array(0),
        restoreEpoch: 0,
        hasSnapshot: true,
        upToSeq: 0,
      };
    };

    const sync = new SyncEngine(client, transport);
    await sync.pull();

    expect(snapshotCalls).toHaveLength(1);
    expect(snapshotCalls[0]).toEqual({ includeData: false });
  });

  it('fetches snapshot data only when the server snapshot is newer and restores from it', async () => {
    const workspaceId = uuidv7();
    const actorA = uuidv7();
    const actorB = uuidv7();
    const relay = new MemoryRelay();

    const dbA = await createTestDatabase();
    const storeA = new WorkspaceStore(dbA, workspaceId, actorA);
    const clientA = await createClientFromStore(storeA);
    const syncA = new SyncEngine(clientA, new MemoryTransport(relay, workspaceId));

    const nodeId1 = uuidv7();
    const nodeId2 = uuidv7();
    storeA.createNode({ nodeId: nodeId1, kind: 'page', parentId: null });
    storeA.createNode({ nodeId: nodeId2, kind: 'page', parentId: null });
    await syncA.push();

    const snapshot = storeA.exportSnapshot();

    const snapshotCalls: Array<{ includeData?: boolean } | undefined> = [];
    const transportB = new MemoryTransport(relay, workspaceId);
    transportB.getLatestSnapshot = async (options?: { includeData?: boolean }) => {
      snapshotCalls.push(options);
      const includeData = options?.includeData !== false;
      return {
        snapshotId: 'snap-1',
        workspaceId,
        hlc: snapshot.hlc,
        data: includeData ? snapshot.data : new Uint8Array(0),
        restoreEpoch: 0,
        hasSnapshot: true,
        upToSeq: 2,
      };
    };

    const dbB = await createTestDatabase();
    const storeB = new WorkspaceStore(dbB, workspaceId, actorB);
    const clientB = await createClientFromStore(storeB);
    const syncB = new SyncEngine(clientB, transportB);

    await syncB.pull();

    // First call is the metadata probe; the second fetches the full snapshot.
    expect(snapshotCalls).toHaveLength(2);
    expect(snapshotCalls[0]).toEqual({ includeData: false });
    expect(snapshotCalls[1]).toBeUndefined();
    expect(storeB.getNode(nodeId1)).toBeDefined();
    expect(storeB.getNode(nodeId2)).toBeDefined();
  });
});


describe('SyncEngine outbox status + quarantine recovery', () => {
  it('quarantines ops after the backoff schedule and recovers them via retryQuarantined', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const workspaceId = uuidv7();
    const actor = uuidv7();
    const relay = new MemoryRelay();

    const db = await createTestDatabase();
    const store = new WorkspaceStore(db, workspaceId, actor);
    const client = await createClientFromStore(store);

    let shouldFail = true;
    const transport = new MemoryTransport(relay, workspaceId);
    const originalSendBatch = transport.sendBatch.bind(transport);
    transport.sendBatch = (envelopes) => {
      if (shouldFail) {
        throw new Error('network error');
      }
      return originalSendBatch(envelopes);
    };

    const countReports: Array<{ pending: number; failed: number; quarantined: number }> = [];
    const sync = new SyncEngine(client, transport, {
      onOutboxCounts: (counts) => countReports.push({ ...counts }),
    });

    const nodeId = uuidv7();
    store.createNode({ nodeId, kind: 'page', parentId: null });

    // RETRY_DELAYS_MS has 5 entries; the 6th failed attempt quarantines.
    const backoffs = [5_000, 15_000, 60_000, 300_000, 1_800_000];
    for (let attempt = 0; attempt < 6; attempt++) {
      await expect(sync.push()).rejects.toThrow('network error');
      vi.advanceTimersByTime((backoffs[attempt] ?? 0) + 1);
    }

    expect(relay.catchUp(workspaceId, 0).envelopes).toHaveLength(0);
    const stuck = store.getOutboxStatusCounts({ physical: 0, logical: 0 });
    expect(stuck.pending).toBe(0);
    expect(stuck.failed).toBe(0);
    expect(stuck.quarantined).toBe(1);

    // Quarantined ops are not picked up by normal pushes.
    await sync.push();
    expect(relay.catchUp(workspaceId, 0).envelopes).toHaveLength(0);

    // The UI surfaced the quarantine through the counts callback.
    expect(countReports.at(-1)).toEqual({ pending: 0, failed: 0, quarantined: 1 });

    // Explicit retry requeues and pushes once connectivity is back.
    shouldFail = false;
    await sync.retryQuarantined();

    expect(relay.catchUp(workspaceId, 0).envelopes).toHaveLength(1);
    const recovered = store.getOutboxStatusCounts({ physical: 0, logical: 0 });
    expect(recovered).toEqual({ pending: 0, failed: 0, quarantined: 0 });
    expect(countReports.at(-1)).toEqual({ pending: 0, failed: 0, quarantined: 0 });

    vi.useRealTimers();
  });

  it('parks un-synced ops on server restore and recovers them via recoverParkedChanges', async () => {
    const workspaceId = uuidv7();
    const actor = uuidv7();
    const relay = new MemoryRelay();

    const db = await createTestDatabase();
    const store = new WorkspaceStore(db, workspaceId, actor);
    const client = await createClientFromStore(store);

    const transport = new MemoryTransport(relay, workspaceId);
    const parkedReports: number[] = [];
    const sync = new SyncEngine(client, transport, {
      onParkedChanges: (count) => parkedReports.push(count),
    });

    // One op already on the server, one local edit never pushed.
    const nodeId = uuidv7();
    store.createNode({ nodeId, kind: 'page', parentId: null });
    await sync.push();
    store.updateText(nodeId, (text) => text.insert(0, 'unsent edit'));
    expect(relay.catchUp(workspaceId, 0).envelopes).toHaveLength(1);

    // The server reports a new restore epoch: local state is invalidated.
    transport.getLatestSnapshot = async () => ({
      snapshotId: '',
      workspaceId,
      hlc: { physical: 0, logical: 0 },
      data: new Uint8Array(0),
      restoreEpoch: 42,
      hasSnapshot: false,
      upToSeq: null,
    });

    await sync.pull();

    // The un-sent op was parked, not discarded; the wipe still happened: the
    // node came back from the re-pulled create op, but the unsent edit is gone.
    expect(parkedReports).toContain(1);
    expect(store.countParkedOperations()).toBe(1);
    expect(store.getNode(nodeId)).toBeDefined();
    expect(store.getNode(nodeId)!.content).not.toContain('unsent edit');

    // Recovery re-applies the parked op locally and re-pushes it.
    await sync.recoverParkedChanges();

    expect(parkedReports.at(-1)).toBe(0);
    expect(store.countParkedOperations()).toBe(0);
    expect(store.getNode(nodeId)!.content).toContain('unsent edit');
    // MemoryRelay does not dedupe by id (the real server does), so the
    // re-pushed create op appears twice; unique ids are the real assertion.
    const ids = new Set(relay.catchUp(workspaceId, 0).envelopes.map((e) => e.id));
    expect(ids.size).toBe(2);
  });

});


describe('SyncEngine realtime (relay WebSocket)', () => {
  class FakeSocket {
    static instances: FakeSocket[] = [];
    readyState = 0;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    close = vi.fn();
    send = vi.fn((data: string) => {
      void data;
    });

    readonly url: string;

    constructor(url: string) {
      this.url = url;
      FakeSocket.instances.push(this);
    }

    emitOpen(): void {
      this.onopen?.(new Event('open'));
    }

    emitMessage(frame: unknown): void {
      this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
    }
  }

  function lastSocket(): FakeSocket {
    const socket = FakeSocket.instances.at(-1);
    if (!socket) throw new Error('no socket created');
    return socket;
  }

  async function createStoreAndEngine(workspaceId: string, actor: string, relay: MemoryRelay) {
    const db = await createTestDatabase();
    const store = new WorkspaceStore(db, workspaceId, actor);
    const client = await createClientFromStore(store);
    const engine = new SyncEngine(client, new MemoryTransport(relay, workspaceId));
    return { store, client, engine };
  }

  it('applies live ops frames and advances the seq cursor', async () => {
    FakeSocket.instances = [];
    const workspaceId = uuidv7();
    const relay = new MemoryRelay();
    const { store: storeA, client: clientA, engine: engineA } = await createStoreAndEngine(workspaceId, uuidv7(), relay);
    const { store: storeB, engine: engineB } = await createStoreAndEngine(workspaceId, uuidv7(), relay);

    // B commits an op to the relay.
    const nodeId = uuidv7();
    storeB.createNode({ nodeId, kind: 'page', parentId: null });
    await engineB.push();
    const envelopes = relay.catchUp(workspaceId, 0).envelopes;

    engineA.startRealtime({
      workspaceId,
      baseUrl: 'http://localhost:8001',
      createSocket: (url) => new FakeSocket(url),
    });
    const socket = lastSocket();
    socket.emitOpen();
    // hello says we are NOT behind (cursor 0 == latestSeq 0 in this harness),
    // then a live frame delivers B's batch with its server seqs.
    socket.emitMessage({ type: 'hello', protocolVersion: 2, restoreEpoch: 0, latestSeq: 0 });
    socket.emitMessage({
      type: 'ops',
      protocolVersion: 2,
      envelopes,
      seqs: { [envelopes[0].id]: 7 },
    });

    await vi.waitFor(() => {
      expect(storeA.getNode(nodeId)).toBeDefined();
    });
    const watermarks = await clientA.query<{ receivedSeq: number }>('loadWatermarks', []);
    expect(watermarks.receivedSeq).toBe(7);

    engineA.stopRealtime();
  });

  it('catches up over HTTP when hello.latestSeq is ahead of the cursor', async () => {
    FakeSocket.instances = [];
    const workspaceId = uuidv7();
    const relay = new MemoryRelay();
    const { store: storeA, engine: engineA } = await createStoreAndEngine(workspaceId, uuidv7(), relay);
    const { store: storeB, engine: engineB } = await createStoreAndEngine(workspaceId, uuidv7(), relay);

    const nodeId = uuidv7();
    storeB.createNode({ nodeId, kind: 'page', parentId: null });
    await engineB.push();

    engineA.startRealtime({
      workspaceId,
      baseUrl: 'http://localhost:8001',
      createSocket: (url) => new FakeSocket(url),
    });
    const socket = lastSocket();
    socket.emitOpen();
    // hello reports the server is ahead: the engine must run an HTTP catch-up
    // (the seq cursor is authoritative, not the live stream).
    socket.emitMessage({ type: 'hello', protocolVersion: 2, restoreEpoch: 0, latestSeq: 50 });

    await vi.waitFor(() => {
      expect(storeA.getNode(nodeId)).toBeDefined();
    });

    engineA.stopRealtime();
  });

  it('fans out presence frames to subscribers without touching the seq cursor', async () => {
    FakeSocket.instances = [];
    const workspaceId = uuidv7();
    const relay = new MemoryRelay();
    const { client: clientA, engine: engineA } = await createStoreAndEngine(workspaceId, uuidv7(), relay);

    const frames: unknown[] = [];
    const unsubscribe = engineA.subscribePresence((frame) => frames.push(frame));

    engineA.startRealtime({
      workspaceId,
      baseUrl: 'http://localhost:8001',
      createSocket: (url) => new FakeSocket(url),
    });
    const socket = lastSocket();
    socket.readyState = 1;
    socket.emitOpen();
    socket.emitMessage({ type: 'hello', protocolVersion: 2, restoreEpoch: 0, latestSeq: 0 });
    socket.emitMessage({
      type: 'presence',
      action: 'user_focus',
      blockUuid: 'block-1',
      user: { id: 'user-2', name: 'Bob', color: '#3b82f6' },
    });

    expect(frames).toEqual([
      {
        type: 'presence',
        action: 'user_focus',
        blockUuid: 'block-1',
        user: { id: 'user-2', name: 'Bob', color: '#3b82f6' },
      },
    ]);

    // Presence never advances the authoritative seq cursor.
    const watermarks = await clientA.query<{ receivedSeq: number }>('loadWatermarks', []);
    expect(watermarks.receivedSeq).toBe(0);

    unsubscribe();
    socket.emitMessage({
      type: 'presence',
      action: 'user_blur',
      blockUuid: 'block-1',
      user: { id: 'user-2', name: 'Bob', color: '#3b82f6' },
    });
    expect(frames).toHaveLength(1);

    engineA.stopRealtime();
  });

  it('sendPresence writes presence frames over the realtime socket', async () => {
    FakeSocket.instances = [];
    const workspaceId = uuidv7();
    const relay = new MemoryRelay();
    const { engine: engineA } = await createStoreAndEngine(workspaceId, uuidv7(), relay);

    // No realtime channel: a safe no-op, and the status is disconnected.
    engineA.sendPresence('focus', 'block-1');
    expect(engineA.getRealtimeStatus()).toBe('disconnected');

    engineA.startRealtime({
      workspaceId,
      baseUrl: 'http://localhost:8001',
      createSocket: (url) => new FakeSocket(url),
    });
    const socket = lastSocket();
    const statuses: string[] = [];
    const unsubStatus = engineA.subscribeRealtimeStatus((s) => statuses.push(s));
    expect(statuses).toEqual(['connecting']);

    socket.readyState = 1;
    socket.emitOpen();
    expect(engineA.getRealtimeStatus()).toBe('connected');

    engineA.sendPresence('focus', 'block-1');
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'presence', action: 'focus', blockUuid: 'block-1' })
    );

    unsubStatus();
    engineA.stopRealtime();
    expect(engineA.getRealtimeStatus()).toBe('disconnected');
  });
});

  it('applies each catch-up page before fetching the next (no full-backlog buffering)', async () => {
    const workspaceId = uuidv7();
    const actorA = uuidv7();
    const actorB = uuidv7();
    const relay = new MemoryRelay();

    const dbA = await createTestDatabase();
    const storeA = new WorkspaceStore(dbA, workspaceId, actorA);
    const clientA = await createClientFromStore(storeA);
    const syncA = new SyncEngine(clientA, new MemoryTransport(relay, workspaceId));

    const nodeIds = [uuidv7(), uuidv7(), uuidv7()];
    for (const nodeId of nodeIds) {
      storeA.createNode({ nodeId, kind: 'page', parentId: null });
    }
    await syncA.push();

    const events: string[] = [];
    const transportB = new MemoryTransport(relay, workspaceId);
    transportB.catchUp = (afterSeq: number) => {
      events.push(`catchUp:${afterSeq}`);
      return relay.catchUp(workspaceId, afterSeq, 2);
    };

    const dbB = await createTestDatabase();
    const storeB = new WorkspaceStore(dbB, workspaceId, actorB);
    const clientB = await createClientFromStore(storeB);
    const originalMutate = clientB.mutate.bind(clientB);
    const mutateSpy = vi.spyOn(clientB, 'mutate').mockImplementation((method, args) => {
      if (method === 'applyMany') {
        events.push(`applyMany:${(args[0] as unknown[]).length}`);
      }
      return originalMutate(method, args);
    });

    const syncB = new SyncEngine(clientB, transportB);
    await syncB.pull();

    // Two pages (2 + 1 ops): each page is applied before the next fetch.
    expect(events).toEqual(['catchUp:0', 'applyMany:2', 'catchUp:2', 'applyMany:1']);
    expect(mutateSpy).toHaveBeenCalledWith('applyMany', expect.anything());
    for (const nodeId of nodeIds) {
      expect(storeB.getNode(nodeId)).toBeDefined();
    }
  });
