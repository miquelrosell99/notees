import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../store';
import { SyncEngine } from '../sync';
import { deriveKey, encryptEnvelope, type EncryptedEnvelope } from '../crypto';
import { uuidv7 } from '../uuid';
import { createTestDatabase } from './helpers';
import type { Transport } from '../transport';
import type { Hlc } from '../clock';

class MockHttpTransport implements Transport {
  sent: EncryptedEnvelope[] = [];
  catchUpEnvelopes: EncryptedEnvelope[] = [];

  async send(envelope: EncryptedEnvelope): Promise<void> {
    this.sent.push(envelope);
  }

  async catchUp(_afterHlc: Hlc): Promise<EncryptedEnvelope[]> {
    return this.catchUpEnvelopes;
  }

  subscribe(_callback: (envelope: EncryptedEnvelope) => void): void {
    // No real-time push in this mock.
  }
}

describe('local-first integration', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  it('creates a node and sends the encrypted operation', async () => {
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const key = await deriveKey('integration-test-secret');
    const db = await createTestDatabase();
    const store = new WorkspaceStore(db, workspaceId, actorId);
    const transport = new MockHttpTransport();
    const sync = new SyncEngine(store, key, transport);

    const nodeId = uuidv7();
    store.createNode({ nodeId, kind: 'page', parentId: null });

    await sync.push();

    expect(transport.sent).toHaveLength(1);
    const envelope = transport.sent[0];
    expect(envelope.actorId).toBe(actorId);
    expect(envelope.opType).toBe('node.create');
    expect(envelope.affectedNodeIds).toContain(nodeId);
  });

  it('applies a catch-up operation so the node appears locally', async () => {
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const key = await deriveKey('integration-test-secret');
    const db = await createTestDatabase();
    const store = new WorkspaceStore(db, workspaceId, actorId);
    const transport = new MockHttpTransport();
    const sync = new SyncEngine(store, key, transport);

    const nodeId = uuidv7();
    const payload = { nodeId, kind: 'page', parentId: null, classIds: [] };
    const encrypted = await encryptEnvelope(payload, key, {
      id: uuidv7(),
      actorId,
      affectedNodeIds: [nodeId],
      opType: 'node.create',
      hlc: { physical: 1000, logical: 0 },
    });

    transport.catchUpEnvelopes = [encrypted];

    await sync.pull();

    const node = store.getNode(nodeId);
    expect(node).toBeDefined();
    expect(node?.kind).toBe('page');
  });
});
