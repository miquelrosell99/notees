import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../../store';
import { uuidv7 } from '../../uuid';
import { createTestDatabase } from '../../__tests__/helpers';
import { projectNodeSummary, hydrateNodeSummaries } from '../NodeSummaryProjection';

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

describe('NodeSummaryProjection', () => {
  it('projects a summary without children or content', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'page', kind: 'page', parentId: null });
    store.updateText('page', (t) => t.insert(0, 'My page'));

    const summary = projectNodeSummary(store.getDb(), 'page');
    expect(summary).toMatchObject({
      id: 'page',
      title: 'My page',
      icon: null,
      childCount: 0,
      backlinkCount: 0,
      hasChildren: false,
    });
  });

  it('reflects child count and backlinks', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'parent', kind: 'page', parentId: null });
    store.updateText('parent', (t) => t.insert(0, 'Parent'));
    store.createNode({ nodeId: 'child', kind: 'block', parentId: null });
    store.moveNode('child', 'parent');

    store.createNode({ nodeId: 'source', kind: 'page', parentId: null });
    store.updateText('source', (t) => t.insert(0, 'See [[parent]]'));

    const summary = projectNodeSummary(store.getDb(), 'parent');
    expect(summary).toMatchObject({
      id: 'parent',
      title: 'Parent',
      childCount: 1,
      backlinkCount: 1,
      hasChildren: true,
    });
  });

  it('hydrates a list of ids in order', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'a', kind: 'page', parentId: null });
    store.createNode({ nodeId: 'b', kind: 'page', parentId: null });
    store.updateText('a', (t) => t.insert(0, 'A'));
    store.updateText('b', (t) => t.insert(0, 'B'));

    const summaries = hydrateNodeSummaries(store.getDb(), ['b', 'a', 'missing']);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({ id: 'b', title: 'B' });
    expect(summaries[1]).toMatchObject({ id: 'a', title: 'A' });
  });
});
