import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '@/core/store';
import { uuidv7 } from '@/core/uuid';
import { createTestDatabase } from '@/core/__tests__/helpers';
import { HydrateLinkedReferencesQuery } from '../HydrateLinkedReferencesQuery';

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

async function makeStore() {
  const db = await createTestDatabase();
  const workspaceId = uuidv7();
  const actorId = uuidv7();
  return new WorkspaceStore(db, workspaceId, actorId);
}

describe('HydrateLinkedReferencesQuery', () => {
  it('hydrates source ids into LinkedReference objects', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'target', kind: 'page', parentId: null });
    store.updateText('target', (t) => t.insert(0, 'Target'));

    store.createNode({ nodeId: 'source-page', kind: 'page', parentId: null });
    store.updateText('source-page', (t) => t.insert(0, 'Source page'));

    store.createNode({ nodeId: 'source', kind: 'block', parentId: 'source-page' });
    store.updateText('source', (t) => t.insert(0, 'See [[target]]'));

    const refs = HydrateLinkedReferencesQuery.execute(store, {
      nodeUuid: 'target',
      sourceIds: ['source'],
    });

    expect(refs).toHaveLength(1);
    expect(refs[0].source_node.uuid).toBe('source');
    expect(refs[0].source_page?.uuid).toBe('source-page');
    expect(refs[0].breadcrumb_path).toEqual([
      { node_uuid: 'source-page', name: 'Source page', is_property: false },
    ]);
    expect(refs[0].context).toBe('See [[target]]');
  });

  it('ignores missing source ids', async () => {
    const store = await makeStore();
    const refs = HydrateLinkedReferencesQuery.execute(store, {
      nodeUuid: 'target',
      sourceIds: ['missing'],
    });
    expect(refs).toHaveLength(0);
  });
});
