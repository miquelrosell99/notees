import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../../../store';
import { uuidv7 } from '../../../uuid';
import { createTestDatabase } from '../../../__tests__/helpers';
import { GetLinkedReferencesQuery } from '../GetLinkedReferencesQuery';

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

describe('GetLinkedReferencesQuery', () => {
  it('returns paginated ids', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'target', kind: 'page', parentId: null });
    store.updateText('target', (t) => t.insert(0, 'Target'));
    for (let i = 0; i < 5; i++) {
      store.createNode({ nodeId: `s-${i}`, kind: 'block', parentId: null });
      store.updateText(`s-${i}`, (t) => t.insert(0, `See [[target]] ${i}`));
    }
    const result = GetLinkedReferencesQuery.execute(store, { nodeUuid: 'target', limit: 2, offset: 0 });
    expect(result.ids).toHaveLength(2);
    expect(result.totalCount).toBe(5);
    expect(result.hasMore).toBe(true);
  });

  it('excludes self-references', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'target', kind: 'page', parentId: null });
    store.updateText('target', (t) => t.insert(0, 'Self reference [[target]]'));

    const result = GetLinkedReferencesQuery.execute(store, { nodeUuid: 'target' });
    expect(result.ids).toHaveLength(0);
    expect(result.totalCount).toBe(0);
  });
});
