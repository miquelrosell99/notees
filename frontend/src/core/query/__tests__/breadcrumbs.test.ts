/**
 * Unit tests for buildBreadcrumbs.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../../store';
import { uuidv7 } from '../../uuid';
import { createTestDatabase } from '../../__tests__/helpers';
import { buildBreadcrumbs } from '../../worker/queryHelpers';

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
    expect(breadcrumbs.map((b) => b.name)).toEqual(['Grandparent page', 'Parent page']);
    expect(breadcrumbs.map((b) => b.display_name)).toEqual(['Grandparent page', 'Parent page']);
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
    expect(breadcrumbs.map((b) => b.display_name)).toEqual(['Target page', 'See Target page']);
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

  it('returns plain text for date-style ancestors created with setNodeText', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'year', kind: 'page', parentId: null });
    store.setNodeText('year', '2024');

    store.createNode({ nodeId: 'month', kind: 'page', parentId: 'year' });
    store.setNodeText('month', '2024-07');

    store.createNode({ nodeId: 'day', kind: 'page', parentId: 'month' });
    store.setNodeText('day', '2024-07-30');

    const breadcrumbs = buildBreadcrumbs(store, 'day');
    expect(breadcrumbs.map((b) => b.name)).toEqual(['2024', '2024-07']);
    expect(breadcrumbs.map((b) => b.display_name)).toEqual(['2024', '2024-07']);
  });

  it('resolves a node_link-only ancestor title without raw AST fallback', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'target', kind: 'page', parentId: null });
    store.updateContentAst('target', [
      { type: 'paragraph', children: [{ type: 'text', text: 'Target page' }] },
    ]);

    store.createNode({ nodeId: 'parent', kind: 'page', parentId: null });
    store.updateContentAst('parent', [
      { type: 'paragraph', children: [{ type: 'node_link', link_id: 'target', ref_type: 'node' }] },
    ]);

    store.createNode({ nodeId: 'child', kind: 'page', parentId: 'parent' });

    const breadcrumbs = buildBreadcrumbs(store, 'child');
    expect(breadcrumbs[0].display_name).toBe('Target page');
    expect(breadcrumbs[0].display_name).not.toContain('[');
  });

  it('resolves node links when ancestor content was saved via setNodeText (JSON-wrapped CRDT)', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'target', kind: 'page', parentId: null });
    store.updateContentAst('target', [
      { type: 'paragraph', children: [{ type: 'text', text: 'GMI Dental Implantology, S.L.' }] },
    ]);

    store.createNode({ nodeId: 'parent', kind: 'block', parentId: null });
    // This mirrors the inline editor save path: the editor serializes the AST
    // to JSON, and useContentSave passes that JSON string to setNodeText. The
    // derived SQLite content column ends up as a single text node wrapping the
    // JSON string.
    store.setNodeText(
      'parent',
      JSON.stringify([
        {
          type: 'paragraph',
          children: [
            { type: 'node_link', link_id: 'target', ref_type: 'node' },
          ],
        },
      ])
    );

    store.createNode({ nodeId: 'child', kind: 'block', parentId: 'parent' });

    const breadcrumbs = buildBreadcrumbs(store, 'child');
    expect(breadcrumbs[0].display_name).toBe('GMI Dental Implantology, S.L.');
    expect(breadcrumbs[0].display_name).not.toContain('[');
    expect(breadcrumbs[0].display_name).not.toBe('…');
  });
});
