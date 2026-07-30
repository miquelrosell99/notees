import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../../store';
import { uuidv7 } from '../../uuid';
import { createTestDatabase } from '../../__tests__/helpers';
import { queryOne } from '../../db/sqlite';
import { rebuildNodeStats } from '../nodeStats';

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

function getStats(db: ReturnType<WorkspaceStore['getDb']>, nodeId: string) {
  return queryOne<{
    child_count: number;
    backlink_count: number;
    reference_count: number;
    descendant_count: number;
  }>(db, 'SELECT child_count, backlink_count, reference_count, descendant_count FROM node_stats WHERE node_id = ?', [nodeId]);
}

describe('rebuildNodeStats', () => {
  it('tracks child and descendant counts through moves', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'parent', kind: 'page', parentId: null });
    store.createNode({ nodeId: 'child', kind: 'block', parentId: null });
    store.createNode({ nodeId: 'grandchild', kind: 'block', parentId: null });

    store.moveNode('child', 'parent');
    store.moveNode('grandchild', 'child');

    const parentStats = getStats(store.getDb(), 'parent');
    expect(parentStats?.child_count).toBe(1);
    expect(parentStats?.descendant_count).toBe(2);

    const childStats = getStats(store.getDb(), 'child');
    expect(childStats?.child_count).toBe(1);
    expect(childStats?.descendant_count).toBe(1);

    const grandchildStats = getStats(store.getDb(), 'grandchild');
    expect(grandchildStats?.child_count).toBe(0);
    expect(grandchildStats?.descendant_count).toBe(0);
  });

  it('tracks backlink and reference counts from text references', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'target', kind: 'page', parentId: null });
    store.updateText('target', (t) => t.insert(0, 'Target page'));

    store.createNode({ nodeId: 'source', kind: 'page', parentId: null });
    store.updateText('source', (t) => t.insert(0, 'See [[target]]'));

    const targetStats = getStats(store.getDb(), 'target');
    expect(targetStats?.backlink_count).toBe(1);

    const sourceStats = getStats(store.getDb(), 'source');
    expect(sourceStats?.reference_count).toBe(1);
  });

  it('updates counts when a reference is removed', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'target', kind: 'page', parentId: null });
    store.createNode({ nodeId: 'source', kind: 'page', parentId: null });
    store.updateText('source', (t) => t.insert(0, 'See [[target]]'));

    expect(getStats(store.getDb(), 'target')?.backlink_count).toBe(1);

    store.updateText('source', (t) => {
      t.delete(0, t.toPlaintext().length);
      t.insert(0, 'No reference');
    });

    expect(getStats(store.getDb(), 'target')?.backlink_count).toBe(0);
    expect(getStats(store.getDb(), 'source')?.reference_count).toBe(0);
  });

  it('can rebuild stats for specific node ids', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'a', kind: 'page', parentId: null });
    store.createNode({ nodeId: 'b', kind: 'page', parentId: null });

    // Reset stats, then rebuild only node a.
    store.getDb().run('DELETE FROM node_stats');
    rebuildNodeStats(store.getDb(), ['a']);

    expect(getStats(store.getDb(), 'a')).toBeDefined();
    expect(getStats(store.getDb(), 'b')).toBeUndefined();
  });
});
