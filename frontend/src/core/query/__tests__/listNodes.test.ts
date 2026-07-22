/**
 * Unit tests for listNodes.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../../store';
import { uuidv7 } from '../../uuid';
import { createTestDatabase } from '../../__tests__/helpers';
import { listNodes } from '../listNodes';

describe('listNodes', () => {
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

  it('returns all nodes by default', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'n1', kind: 'page', parentId: null });
    store.createNode({ nodeId: 'n2', kind: 'block', parentId: null });

    const results = listNodes(store);
    expect(results.map((n) => n.uuid).sort()).toEqual(['n1', 'n2']);
  });

  it('filters pages only', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'p1', kind: 'page', parentId: null });
    store.createNode({ nodeId: 'b1', kind: 'block', parentId: null });

    const results = listNodes(store, { pages_only: true });
    expect(results.map((n) => n.uuid)).toEqual(['p1']);
  });

  it('filters by parent_uuid', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'parent', kind: 'page', parentId: null });
    store.createNode({ nodeId: 'child', kind: 'block', parentId: 'parent' });
    store.createNode({ nodeId: 'other', kind: 'block', parentId: null });

    const results = listNodes(store, { parent_uuid: 'parent' });
    expect(results.map((n) => n.uuid)).toEqual(['child']);
  });

  it('filters by tag_uuid (class UUID)', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'tagged', kind: 'page', parentId: null, classIds: ['class-1'] });
    store.createNode({ nodeId: 'untagged', kind: 'page', parentId: null });

    const results = listNodes(store, { tag_uuid: 'class-1' });
    expect(results.map((n) => n.uuid)).toEqual(['tagged']);
  });

  it('respects page_size', async () => {
    const store = await makeStore();
    for (let i = 0; i < 10; i++) {
      store.createNode({ nodeId: `n-${i}`, kind: 'page', parentId: null });
    }

    const results = listNodes(store, { page_size: 3 });
    expect(results).toHaveLength(3);
  });
});
