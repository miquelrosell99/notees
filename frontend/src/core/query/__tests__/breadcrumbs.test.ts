/**
 * Unit tests for buildBreadcrumbs.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../../store';
import { uuidv7 } from '../../uuid';
import { createTestDatabase } from '../../__tests__/helpers';
import { buildBreadcrumbs } from '../breadcrumbs';

describe('buildBreadcrumbs', () => {
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

  it('returns plain text names for ancestors', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'grandparent', kind: 'page', parentId: null });
    store.updateContentAst('grandparent', [
      { type: 'paragraph', children: [{ type: 'text', text: 'Grandparent page' }] },
    ]);

    store.createNode({ nodeId: 'parent', kind: 'page', parentId: 'grandparent' });
    store.updateContentAst('parent', [
      { type: 'paragraph', children: [{ type: 'text', text: 'Parent page' }] },
    ]);

    store.createNode({ nodeId: 'child', kind: 'page', parentId: 'parent' });

    const breadcrumbs = buildBreadcrumbs(store, 'child');
    expect(breadcrumbs.map((b) => b.name)).toEqual(['Parent page', 'Grandparent page']);
    expect(breadcrumbs.map((b) => b.display_name)).toEqual(['Parent page', 'Grandparent page']);
  });

  it('resolves node links in ancestor names recursively', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'target', kind: 'page', parentId: null });
    store.updateContentAst('target', [
      { type: 'paragraph', children: [{ type: 'text', text: 'Target page' }] },
    ]);

    store.createNode({ nodeId: 'middle', kind: 'page', parentId: 'target' });
    store.updateContentAst('middle', [
      {
        type: 'paragraph',
        children: [
          { type: 'text', text: 'See ' },
          { type: 'node_link', link_id: 'target', ref_type: 'node' },
        ],
      },
    ]);

    store.createNode({ nodeId: 'child', kind: 'page', parentId: 'middle' });

    const breadcrumbs = buildBreadcrumbs(store, 'child');
    expect(breadcrumbs.map((b) => b.display_name)).toEqual(['See Target page', 'Target page']);
  });

  it('breaks cycles when a node name links to itself', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'self-ref', kind: 'page', parentId: null });
    store.updateContentAst('self-ref', [
      {
        type: 'paragraph',
        children: [{ type: 'node_link', link_id: 'self-ref', ref_type: 'node' }],
      },
    ]);

    store.createNode({ nodeId: 'child', kind: 'page', parentId: 'self-ref' });

    const breadcrumbs = buildBreadcrumbs(store, 'child');
    expect(breadcrumbs[0].display_name).toBe('…');
  });

  it('does not include the start node in the breadcrumb chain', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'root', kind: 'page', parentId: null });
    store.updateContentAst('root', [{ type: 'paragraph', children: [{ type: 'text', text: 'Root' }] }]);

    store.createNode({ nodeId: 'child', kind: 'page', parentId: 'root' });

    const breadcrumbs = buildBreadcrumbs(store, 'child');
    expect(breadcrumbs.map((b) => b.name)).toEqual(['Root']);
    expect(breadcrumbs.map((b) => b.display_name)).toEqual(['Root']);
  });
});
