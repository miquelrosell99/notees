/**
 * Unit tests for the SQLite-derived search index.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../../store';
import { uuidv7 } from '../../uuid';
import { createTestDatabase } from '../../__tests__/helpers';
import { searchNodes } from '../search';

describe('searchNodes', () => {
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

  function createPage(store: WorkspaceStore, nodeId: string, text: string): void {
    store.createNode({ nodeId, kind: 'page', parentId: null });
    store.updateText(nodeId, (t) => t.insert(0, text));
  }

  it('finds nodes by name text', async () => {
    const store = await makeStore();
    createPage(store, 'n1', 'Hello world');
    createPage(store, 'n2', 'Goodbye moon');

    const results = searchNodes(store, 'world');
    expect(results.map((r) => r.id)).toContain('n1');
    expect(results.map((r) => r.id)).not.toContain('n2');
  });

  it('supports prefix matches', async () => {
    const store = await makeStore();
    createPage(store, 'n1', 'Project planning');

    const results = searchNodes(store, 'proj');
    expect(results.map((r) => r.id)).toContain('n1');
  });

  it('filters by isPage', async () => {
    const store = await makeStore();
    createPage(store, 'p1', 'A page');
    store.createNode({ nodeId: 'b1', kind: 'block', parentId: null });
    store.updateText('b1', (t) => t.insert(0, 'A block'));

    const pages = searchNodes(store, 'A', { isPage: true });
    expect(pages.map((r) => r.id)).toEqual(['p1']);
  });

  it('filters by class UUID intersection', async () => {
    const store = await makeStore();
    createPage(store, 'n1', 'Task A');
    createPage(store, 'n2', 'Task B');
    store.getDb().run('UPDATE node SET class_ids = ? WHERE id = ?', [JSON.stringify(['class-1']), 'n1']);
    store.getDb().run('UPDATE node SET class_ids = ? WHERE id = ?', [JSON.stringify(['class-2']), 'n2']);

    const results = searchNodes(store, 'Task', { classUuids: ['class-1'] });
    expect(results.map((r) => r.id)).toEqual(['n1']);
  });

  it('removes deleted nodes from results', async () => {
    const store = await makeStore();
    createPage(store, 'n1', 'Hello world');
    createPage(store, 'n2', 'Hello moon');
    store.deleteNode('n1');

    const results = searchNodes(store, 'Hello');
    expect(results.map((r) => r.id)).not.toContain('n1');
    expect(results.map((r) => r.id)).toContain('n2');
  });

  it('ranks documents with more hits higher', async () => {
    const store = await makeStore();
    createPage(store, 'n1', 'project');
    createPage(store, 'n2', 'project project project');

    const results = searchNodes(store, 'project');
    expect(results.map((r) => r.id)).toEqual(['n2', 'n1']);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('supports unicode tokenisation with diacritic folding', async () => {
    const store = await makeStore();
    createPage(store, 'n1', 'Café naïve');
    createPage(store, 'n2', 'Regular cafe');

    const results = searchNodes(store, 'café');
    expect(results.map((r) => r.id)).toContain('n1');
    // unicode61 folds diacritics, so café also matches cafe.
    expect(results.map((r) => r.id)).toContain('n2');
  });

  it('requires all query terms to match', async () => {
    const store = await makeStore();
    createPage(store, 'n1', 'project planning');
    createPage(store, 'n2', 'project management');

    const results = searchNodes(store, 'project planning');
    expect(results.map((r) => r.id)).toContain('n1');
    expect(results.map((r) => r.id)).not.toContain('n2');
  });

  it('returns empty results for an empty query', async () => {
    const store = await makeStore();
    createPage(store, 'n1', 'Hello');

    const results = searchNodes(store, '');
    expect(results).toHaveLength(0);
  });
});
