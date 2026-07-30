import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../../../store';
import { uuidv7 } from '../../../uuid';
import { createTestDatabase } from '../../../__tests__/helpers';
import { GetChildrenQuery } from '../GetChildrenQuery';

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

describe('GetChildrenQuery', () => {
  it('returns child ids for a node', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'parent', kind: 'page', parentId: null });
    store.createNode({ nodeId: 'child-a', kind: 'block', parentId: null });
    store.createNode({ nodeId: 'child-b', kind: 'block', parentId: null });
    store.moveNode('child-a', 'parent');
    store.moveNode('child-b', 'parent');

    const result = GetChildrenQuery.execute(store, { nodeUuid: 'parent' });
    expect(result.ids).toEqual(['child-a', 'child-b']);
    expect(result.totalCount).toBe(2);
    expect(result.hasMore).toBe(false);
  });

  it('returns empty output when node has no children', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'parent', kind: 'page', parentId: null });

    const result = GetChildrenQuery.execute(store, { nodeUuid: 'parent' });
    expect(result.ids).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(result.hasMore).toBe(false);
  });
});
