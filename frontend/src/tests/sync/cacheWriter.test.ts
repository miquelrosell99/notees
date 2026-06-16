/**
 * Tests for cacheWriter.
 *
 * cacheWriter must update TanStack Query node caches deterministically
 * without triggering broad invalidations.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import { nodeKeys } from '@/hooks/queryKeys';
import { writeCreate, writeUpdate, writeDelete, writeMove } from '@/sync/cacheWriter';

function node(id: number, overrides: Partial<Node> = {}): Node {
  return {
    id,
    uuid: `uuid-${id}`,
    name: `[{"type":"paragraph","children":[{"type":"text","text":"node ${id}"}]}]`,
    icon: null,
    color: null,
    parent_id: null,
    page_id: null,
    sequence: 0,
    collapsed: false,
    active: true,
    is_page: true,
    create_date: new Date().toISOString(),
    write_date: new Date().toISOString(),
    children: [],
    ...overrides,
  };
}

describe('cacheWriter', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  });

  it('inserts a created child into a parent cache', () => {
    const parent = node(1, { children: [node(2)] });
    queryClient.setQueryData(nodeKeys.detailBase(1), parent);

    const child = node(3, { parent_id: 1, sequence: 5, is_page: false });
    writeCreate(queryClient, 1, child);

    const cached = queryClient.getQueryData<Node>(nodeKeys.detailBase(1));
    expect(cached?.children).toHaveLength(2);
    expect(cached?.children?.some((c) => c.id === 3)).toBe(true);
  });

  it('updates a node field across tree caches', () => {
    const target = node(2, { name: 'old' });
    queryClient.setQueryData(nodeKeys.detailBase(2), target);

    writeUpdate(queryClient, 2, { name: 'new' });

    const cached = queryClient.getQueryData<Node>(nodeKeys.detailBase(2));
    expect(cached?.name).toBe('new');
  });

  it('deletes a node from tree caches', () => {
    const root = node(1, { children: [node(2), node(3)] });
    queryClient.setQueryData(nodeKeys.pageContent(1), root);

    writeDelete(queryClient, 2);

    const cached = queryClient.getQueryData<Node>(nodeKeys.pageContent(1));
    expect(cached?.children?.map((c) => c.id)).toEqual([3]);
  });

  it('moves a node to a new parent and sequence', () => {
    const root = node(1, { children: [node(2, { parent_id: 1 }), node(3, { parent_id: 1 })] });
    queryClient.setQueryData(nodeKeys.detailBase(1), root);

    const moved = node(2, { parent_id: 1, sequence: 10 });
    writeMove(queryClient, 2, 1, 10, moved);

    const cached = queryClient.getQueryData<Node>(nodeKeys.detailBase(1));
    const child = cached?.children?.find((c) => c.id === 2);
    expect(child).toBeDefined();
    expect(child?.parent_id).toBe(1);
  });
});
