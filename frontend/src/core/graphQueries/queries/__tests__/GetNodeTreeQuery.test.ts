import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../../../store';
import { uuidv7 } from '../../../uuid';
import { createTestDatabase } from '../../../__tests__/helpers';
import { GetNodeTreeQuery } from '../GetNodeTreeQuery';

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

describe('GetNodeTreeQuery', () => {
  it('returns the root row and its descendants', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'page', kind: 'page', parentId: null });
    store.createNode({ nodeId: 'child-a', kind: 'block', parentId: null });
    store.createNode({ nodeId: 'child-b', kind: 'block', parentId: null });
    store.createNode({ nodeId: 'grandchild', kind: 'block', parentId: null });
    store.moveNode('child-a', 'page');
    store.moveNode('child-b', 'page');
    store.moveNode('grandchild', 'child-a');

    const result = GetNodeTreeQuery.execute(store, { nodeUuid: 'page', maxDepth: -1 });
    const ids = result.rows.map((r) => r.id);

    expect(ids).toEqual(['page', 'child-a', 'grandchild', 'child-b']);
    expect(result.rows[0]).toMatchObject({
      id: 'page',
      parentId: null,
      depth: 0,
      kind: 'page',
    });
    expect(result.rows.find((r) => r.id === 'child-a')).toMatchObject({
      parentId: 'page',
      depth: 1,
      kind: 'block',
    });
    expect(result.rows.find((r) => r.id === 'grandchild')).toMatchObject({
      parentId: 'child-a',
      depth: 2,
      kind: 'block',
    });
  });

  it('respects maxDepth', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'page', kind: 'page', parentId: null });
    store.createNode({ nodeId: 'child', kind: 'block', parentId: null });
    store.createNode({ nodeId: 'grandchild', kind: 'block', parentId: null });
    store.moveNode('child', 'page');
    store.moveNode('grandchild', 'child');

    const result = GetNodeTreeQuery.execute(store, { nodeUuid: 'page', maxDepth: 1 });
    const ids = result.rows.map((r) => r.id);

    expect(ids).toEqual(['page', 'child']);
    expect(result.rows.some((r) => r.id === 'grandchild')).toBe(false);
  });

  it('orders children by node_child_order.position', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'page', kind: 'page', parentId: null });
    store.createNode({ nodeId: 'first', kind: 'block', parentId: null });
    store.createNode({ nodeId: 'second', kind: 'block', parentId: null });
    store.createNode({ nodeId: 'third', kind: 'block', parentId: null });
    store.moveNode('first', 'page');
    store.moveNode('second', 'page');
    store.moveNode('third', 'page');

    const result = GetNodeTreeQuery.execute(store, { nodeUuid: 'page', maxDepth: -1 });
    const childIds = result.rows.filter((r) => r.parentId === 'page').map((r) => r.id);

    expect(childIds).toEqual(['first', 'second', 'third']);
  });

  it('returns classIds as a parsed array', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'page', kind: 'page', parentId: null });

    const result = GetNodeTreeQuery.execute(store, { nodeUuid: 'page', maxDepth: -1 });
    const row = result.rows.find((r) => r.id === 'page');

    expect(row).toBeDefined();
    expect(Array.isArray(row!.classIds)).toBe(true);
  });

  it('terminates when the child graph contains a cycle', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'page', kind: 'page', parentId: null });
    store.createNode({ nodeId: 'child-a', kind: 'block', parentId: null });
    store.createNode({ nodeId: 'child-b', kind: 'block', parentId: null });
    store.moveNode('child-a', 'page');
    store.moveNode('child-b', 'child-a');
    // Introduce a cycle: child-a is also a child of child-b.
    store.getDb().run(
      'INSERT OR REPLACE INTO node_child_order (parent_id, child_id, position) VALUES (?, ?, ?)',
      ['child-b', 'child-a', 'z']
    );

    const result = GetNodeTreeQuery.execute(store, { nodeUuid: 'page', maxDepth: -1 });
    const ids = result.rows.map((r) => r.id);

    expect(ids).toEqual(['page', 'child-a', 'child-b']);
  });

  it('invalidates on tree-scoped notifications and the root node id', () => {
    expect(
      GetNodeTreeQuery.shouldInvalidate(
        { nodeUuid: 'page', maxDepth: -1 },
        { type: 'notify', scope: 'tree' }
      )
    ).toBe(true);
    expect(
      GetNodeTreeQuery.shouldInvalidate(
        { nodeUuid: 'page', maxDepth: -1 },
        { type: 'notify', scope: 'all' }
      )
    ).toBe(true);
    expect(GetNodeTreeQuery.shouldInvalidate({ nodeUuid: 'page', maxDepth: -1 }, { type: 'notify', nodeId: 'page' })).toBe(true);
    expect(GetNodeTreeQuery.shouldInvalidate({ nodeUuid: 'page', maxDepth: -1 }, { type: 'notify', nodeId: 'other' })).toBe(false);
  });
});
