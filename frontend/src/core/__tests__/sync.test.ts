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
    expect(relay.catchUp(workspaceId, { physical: 0, logical: 0 })).toHaveLength(1);

    // A second push with no new operations should not send anything.
    await syncA.push();
    expect(relay.catchUp(workspaceId, { physical: 0, logical: 0 })).toHaveLength(1);

    // A new operation should be pushed.
    storeA.updateText(nodeId, (text) => text.insert(0, 'hello'));
    await syncA.push();
    expect(relay.catchUp(workspaceId, { physical: 0, logical: 0 })).toHaveLength(2);
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
});
