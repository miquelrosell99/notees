import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getOrCreateWorkspaceStoreClient,
  closeWorkspaceStoreClient,
} from '../workspaceStoreClientAdapter';
import { closeWorkspaceStore } from '../workspaceStoreAdapter';
import { MemoryRelay, MemoryTransport } from '@/core/transport';
import { uuidv7 } from '@/core/uuid';

describe('workspaceStoreClientAdapter', () => {
  function createTestTransport(workspaceId: string) {
    return new MemoryTransport(new MemoryRelay(), workspaceId);
  }

  async function cleanup(workspaceId: string): Promise<void> {
    await closeWorkspaceStore(workspaceId).catch(() => {
      // Ignore errors if the workspace was never opened at the adapter level.
    });
    closeWorkspaceStoreClient(workspaceId);
  }

  beforeEach(() => {
    // Ensure any leaked clients from previous test runs are closed.
    closeWorkspaceStoreClient('ws-test');
  });

  afterEach(async () => {
    await cleanup('ws-test');
  });

  it('serializes concurrent open attempts to a single shared store', async () => {
    const workspaceId = 'ws-test';
    const actorId = uuidv7();
    const transport = createTestTransport(workspaceId);
    const nodeId = uuidv7();

    const [clientA, clientB] = await Promise.all([
      getOrCreateWorkspaceStoreClient(workspaceId, actorId, transport),
      getOrCreateWorkspaceStoreClient(workspaceId, actorId, transport),
    ]);

    // In jsdom/test mode each resolved client is a separate inline wrapper, but
    // the serialization guard ensures they share the same underlying store.
    await clientA.mutate('createNode', [
      { nodeId, kind: 'page', parentId: null, classIds: [] },
    ]);
    const node = await clientB.query('getNode', [nodeId]);
    expect(node).toBeDefined();
    expect((node as { id: string }).id).toBe(nodeId);
    expect(clientA.isClosed()).toBe(false);
    expect(clientB.isClosed()).toBe(false);
  });

  it('recreates the client after it has been closed', async () => {
    const workspaceId = 'ws-test';
    const actorId = uuidv7();
    const transport = createTestTransport(workspaceId);

    const first = await getOrCreateWorkspaceStoreClient(workspaceId, actorId, transport);
    first.close();

    const second = await getOrCreateWorkspaceStoreClient(workspaceId, actorId, transport);
    expect(second).not.toBe(first);
    expect(second.isClosed()).toBe(false);
  });
});
