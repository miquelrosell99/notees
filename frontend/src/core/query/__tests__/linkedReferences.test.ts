/**
 * Unit tests for buildLinkedReferences.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../../store';
import { uuidv7 } from '../../uuid';
import { createTestDatabase } from '../../__tests__/helpers';
import { buildLinkedReferences } from '../linkedReferences';

describe('buildLinkedReferences', () => {
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

  it('finds text references to a page', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'target', kind: 'page', parentId: null });
    store.updateText('target', (t) => t.insert(0, 'Target page'));

    store.createNode({ nodeId: 'source', kind: 'block', parentId: null });
    store.updateText('source', (t) => t.insert(0, 'See [[target]]'));

    const response = buildLinkedReferences(store, 'target');
    expect(response.linked_references).toHaveLength(1);
    expect(response.linked_references[0].source_node.uuid).toBe('source');
    expect(response.total_count).toBe(1);
  });

  it('excludes self-references', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'target', kind: 'page', parentId: null });
    store.updateText('target', (t) => t.insert(0, 'Self reference [[target]]'));

    const response = buildLinkedReferences(store, 'target');
    expect(response.linked_references).toHaveLength(0);
  });

  it('paginates results', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'target', kind: 'page', parentId: null });
    store.updateText('target', (t) => t.insert(0, 'Target page'));

    for (let i = 0; i < 5; i++) {
      store.createNode({ nodeId: `source-${i}`, kind: 'block', parentId: null });
      store.updateText(`source-${i}`, (t) => t.insert(0, `See [[target]] ${i}`));
    }

    const response = buildLinkedReferences(store, 'target', { limit: 2, offset: 1 });
    expect(response.linked_references).toHaveLength(2);
    expect(response.total_count).toBe(5);
  });

  it('builds breadcrumbs from block to page', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'target-page', kind: 'page', parentId: null });
    store.updateText('target-page', (t) => t.insert(0, 'Target page'));

    store.createNode({ nodeId: 'source-page', kind: 'page', parentId: null });
    store.updateText('source-page', (t) => t.insert(0, 'Source page'));

    store.createNode({ nodeId: 'parent-block', kind: 'block', parentId: 'source-page' });
    store.updateText('parent-block', (t) => t.insert(0, 'Parent block'));

    store.createNode({ nodeId: 'source', kind: 'block', parentId: 'parent-block' });
    store.updateText('source', (t) => t.insert(0, 'See [[target-page]]'));

    const response = buildLinkedReferences(store, 'target-page');
    expect(response.linked_references).toHaveLength(1);
    expect(response.linked_references[0].breadcrumb_path).toEqual([
      { node_uuid: 'source-page', name: 'Source page', is_property: false },
      { node_uuid: 'parent-block', name: 'Parent block', is_property: false },
    ]);
    expect(response.linked_references[0].source_page?.uuid).toBe('source-page');
  });
});
