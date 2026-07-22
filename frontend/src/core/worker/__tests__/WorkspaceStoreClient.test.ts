import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createWorkspaceStoreClient,
  resetSharedWorkspaceStoreClient,
} from '../WorkspaceStoreClient';
import type { IWorkspaceStoreClient } from '../workerProtocol';
import { uuidv7 } from '../../uuid';

describe('WorkspaceStoreClient', () => {
  let client: IWorkspaceStoreClient;

  beforeEach(() => {
    client = createWorkspaceStoreClient();
  });

  afterEach(() => {
    client.close();
    resetSharedWorkspaceStoreClient();
  });

  it('initializes and exports an empty workspace database', async () => {
    const workspaceId = uuidv7();
    const actorId = uuidv7();

    await client.init(workspaceId, actorId);
    const bytes = await client.export();

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('initializes with persisted database bytes', async () => {
    const workspaceId = uuidv7();
    const actorId = uuidv7();

    await client.init(workspaceId, actorId);
    const firstExport = await client.export();

    const secondClient = createWorkspaceStoreClient();
    await secondClient.init(workspaceId, actorId, { dbBytes: firstExport });
    const secondExport = await secondClient.export();
    secondClient.close();

    expect(secondExport.length).toBeGreaterThan(0);
  });

  it('mutates and queries data through the worker boundary', async () => {
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const nodeId = uuidv7();

    await client.init(workspaceId, actorId);
    await client.mutate('createNode', [
      { nodeId, kind: 'page', parentId: null, classIds: [] },
    ]);
    const node = await client.query('getNode', [nodeId]);

    expect(node).toBeDefined();
    expect((node as { id: string }).id).toBe(nodeId);
  });
});
