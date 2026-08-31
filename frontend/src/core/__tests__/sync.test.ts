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
});
