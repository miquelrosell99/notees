import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../store';
import { SyncEngine } from '../sync';
import { MemoryRelay, MemoryTransport } from '../transport';
import { deriveKey } from '../crypto';
import { uuidv7 } from '../uuid';
import { createTestDatabase } from './helpers';

describe('SyncEngine', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  it('converges two workspace stores via in-memory transport', async () => {
    const workspaceId = uuidv7();
    const actorA = uuidv7();
    const actorB = uuidv7();
    const key = await deriveKey('test-password');
    const relay = new MemoryRelay();

    const dbA = await createTestDatabase();
    const dbB = await createTestDatabase();
    const storeA = new WorkspaceStore(dbA, workspaceId, actorA);
    const storeB = new WorkspaceStore(dbB, workspaceId, actorB);
    const syncA = new SyncEngine(storeA, key, new MemoryTransport(relay, workspaceId));
    const syncB = new SyncEngine(storeB, key, new MemoryTransport(relay, workspaceId));

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
});
