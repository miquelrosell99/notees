import { describe, it, expect } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { WorkspaceStore } from '../store';
import { SyncEngine } from '../sync';
import { MemoryRelay, MemoryTransport } from '../transport';
import { uuidv7 } from '../uuid';
import { createTestDatabase } from './helpers';
import { WorkspaceStoreProvider } from '../hooks/WorkspaceStoreProvider';
import { useNode } from '../hooks/useNode';

const WORKSPACE_ID = 'ws-convergence-test';
const ACTOR_A = 'actor-convergence-a';
const ACTOR_B = 'actor-convergence-b';

async function setupPair() {
  const relay = new MemoryRelay();

  const dbA = await createTestDatabase();
  const dbB = await createTestDatabase();
  const storeA = new WorkspaceStore(dbA, WORKSPACE_ID, ACTOR_A);
  const storeB = new WorkspaceStore(dbB, WORKSPACE_ID, ACTOR_B);

  const syncA = new SyncEngine(storeA, new MemoryTransport(relay, WORKSPACE_ID));
  const syncB = new SyncEngine(storeB, new MemoryTransport(relay, WORKSPACE_ID));

  return { relay, storeA, storeB, syncA, syncB };
}

describe('multi-client convergence', () => {
  it('creates a node in store A and store B sees it after sync', async () => {
    const { storeA, storeB, syncA, syncB } = await setupPair();

    const nodeId = uuidv7();
    storeA.createNode({ nodeId, kind: 'page', parentId: null });

    await syncA.push();
    await syncB.pull();

    const nodeB = storeB.getNode(nodeId);
    expect(nodeB).toBeDefined();
    expect(nodeB!.kind).toBe('page');
  });

  it('reflects a remote node in useNode after sync', async () => {
    const { relay, storeA, syncA } = await setupPair();

    const nodeId = uuidv7();
    storeA.createNode({ nodeId, kind: 'block', parentId: null });
    await syncA.push();

    function Wrapper({ children }: { children: React.ReactNode }) {
      return (
        <WorkspaceStoreProvider actorId={ACTOR_B} transport={new MemoryTransport(relay, WORKSPACE_ID)}>
          {children}
        </WorkspaceStoreProvider>
      );
    }

    const { result } = renderHook(() => useNode(WORKSPACE_ID, nodeId), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // The provider kicks off an initial sync in the background; wait for it.
    await waitFor(() => expect(result.current.node).toBeDefined(), { timeout: 2000 });

    expect(result.current.node!.id).toBe(nodeId);
    expect(result.current.node!.kind).toBe('block');
  });

  it('converges concurrent text edits to the same content string', async () => {
    const { storeA, storeB, syncA, syncB } = await setupPair();

    const nodeId = uuidv7();
    storeA.createNode({ nodeId, kind: 'page', parentId: null });
    storeA.updateText(nodeId, (text) => text.insert(0, 'Hello '));

    await syncA.push();
    await syncB.pull();

    // Both stores now edit concurrently while disconnected.
    storeA.updateText(nodeId, (text) => text.insert(text.toPlaintext().length, 'Alice'));
    storeB.updateText(nodeId, (text) => text.insert(text.toPlaintext().length, 'Bob'));

    // Sync both ways.
    await syncA.push();
    await syncB.push();
    await syncA.pull();
    await syncB.pull();

    const contentA = JSON.parse(storeA.getNode(nodeId)!.content);
    const contentB = JSON.parse(storeB.getNode(nodeId)!.content);

    // CRDT convergence: both stores end up with identical content.
    expect(contentA[0].text).toBe(contentB[0].text);
    expect(contentA[0].text).toContain('Hello ');
    expect(contentA[0].text).toContain('Alice');
    expect(contentA[0].text).toContain('Bob');
  });
});
