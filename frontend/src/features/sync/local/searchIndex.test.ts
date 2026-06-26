/**
 * Unit tests for the MiniSearch offline index.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { indexNodes, searchIndex, unindexNodes, clearSearchIndex, _resetMemoryIndex } from './searchIndex';
import type { Node } from '@/types/api';

const WORKSPACE = 'ws-search-1';

function makeNode(
  uuid: string,
  name: string,
  overrides: Partial<Node> = {},
): Node {
  return {
    uuid,
    name,
    icon: null,
    color: null,
    parent_uuid: null,
    page_uuid: null,
    sequence: 0,
    active: true,
    is_page: false,
    create_date: new Date().toISOString(),
    write_date: new Date().toISOString(),
    ...overrides,
  };
}

describe('searchIndex', () => {
  beforeEach(() => {
    _resetMemoryIndex();
  });

  it('finds nodes by name text', async () => {
    await indexNodes(WORKSPACE, [
      makeNode('n1', 'Hello world'),
      makeNode('n2', 'Goodbye moon'),
    ]);
    const results = await searchIndex(WORKSPACE, 'world');
    expect(results.map((r) => r.id)).toContain('n1');
    expect(results.map((r) => r.id)).not.toContain('n2');
  });

  it('supports prefix matches', async () => {
    await indexNodes(WORKSPACE, [makeNode('n1', 'Project planning')]);
    const results = await searchIndex(WORKSPACE, 'proj');
    expect(results.map((r) => r.id)).toContain('n1');
  });

  it('filters by isPage', async () => {
    await indexNodes(WORKSPACE, [
      makeNode('p1', 'A page', { is_page: true }),
      makeNode('b1', 'A block', { is_page: false }),
    ]);
    const pages = await searchIndex(WORKSPACE, 'A', { isPage: true });
    expect(pages.map((r) => r.id)).toEqual(['p1']);
  });

  it('filters by class UUID intersection', async () => {
    await indexNodes(WORKSPACE, [
      makeNode('n1', 'Task A', { classes_uuid: ['class-1'] }),
      makeNode('n2', 'Task B', { classes_uuid: ['class-2'] }),
    ]);
    const results = await searchIndex(WORKSPACE, 'Task', { classUuids: ['class-1'] });
    expect(results.map((r) => r.id)).toEqual(['n1']);
  });

  it('removes unindexed nodes from results', async () => {
    await indexNodes(WORKSPACE, [
      makeNode('n1', 'Hello world'),
      makeNode('n2', 'Hello moon'),
    ]);
    await unindexNodes(WORKSPACE, ['n1']);
    const results = await searchIndex(WORKSPACE, 'Hello');
    expect(results.map((r) => r.id)).not.toContain('n1');
    expect(results.map((r) => r.id)).toContain('n2');
  });

  it('clears the index for a workspace', async () => {
    await indexNodes(WORKSPACE, [makeNode('n1', 'Hello')]);
    await clearSearchIndex(WORKSPACE);
    const results = await searchIndex(WORKSPACE, 'Hello');
    expect(results).toHaveLength(0);
  });

  it('returns empty results for an empty query', async () => {
    await indexNodes(WORKSPACE, [makeNode('n1', 'Hello'), makeNode('n2', 'World')]);
    const results = await searchIndex(WORKSPACE, '');
    expect(results).toHaveLength(0);
  });
});
