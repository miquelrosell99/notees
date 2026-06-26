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

function makeNode(nodeUuid: string, overrides: Partial<Node> = {}): Node {
  return {
    uuid: nodeUuid,
    name: `[{"type":"paragraph","children":[{"type":"text","text":"node ${nodeUuid}"}]}]`,
    icon: null,
    color: null,
    parent_uuid: null,
    page_uuid: null,
    sequence: 0,
    collapsed: false,
    active: true,
    is_page: true,
    create_date: new Date().toISOString(),
    write_date: new Date().toISOString(),
    children: [],
    ...overrides,
  } as Node;
}

describe('cacheWriter', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  });

  it('inserts a created child into a parent cache', () => {
    const parent = makeNode('00000000-0000-0000-0000-000000000001', { children: [makeNode('00000000-0000-0000-0000-000000000002')] });
    queryClient.setQueryData(nodeKeys.detailBase('00000000-0000-0000-0000-000000000001'), parent);

    const child = makeNode('00000000-0000-0000-0000-000000000003', { parent_uuid: '00000000-0000-0000-0000-000000000001', sequence: 5, is_page: false });
    writeCreate(queryClient, '00000000-0000-0000-0000-000000000001', child);

    const cached = queryClient.getQueryData<Node>(nodeKeys.detailBase('00000000-0000-0000-0000-000000000001'));
    expect(cached?.children).toHaveLength(2);
    expect(cached?.children?.some((c) => c.uuid === '00000000-0000-0000-0000-000000000003')).toBe(true);
  });

  it('updates a node field across tree caches', () => {
    const target = makeNode('00000000-0000-0000-0000-000000000002', { name: 'old' });
    queryClient.setQueryData(nodeKeys.detailBase('00000000-0000-0000-0000-000000000002'), target);

    writeUpdate(queryClient, '00000000-0000-0000-0000-000000000002', { name: 'new' });

    const cached = queryClient.getQueryData<Node>(nodeKeys.detailBase('00000000-0000-0000-0000-000000000002'));
    expect(cached?.name).toBe('new');
  });

  it('deletes a node from tree caches', () => {
    const root = makeNode('00000000-0000-0000-0000-000000000001', { children: [makeNode('00000000-0000-0000-0000-000000000002'), makeNode('00000000-0000-0000-0000-000000000003')] });
    queryClient.setQueryData(nodeKeys.pageContent('00000000-0000-0000-0000-000000000001'), root);

    writeDelete(queryClient, '00000000-0000-0000-0000-000000000002');

    const cached = queryClient.getQueryData<Node>(nodeKeys.pageContent('00000000-0000-0000-0000-000000000001'));
    expect(cached?.children?.map((c) => c.uuid)).toEqual(['00000000-0000-0000-0000-000000000003']);
  });

  it('moves a node to a new parent and sequence', () => {
    const root = makeNode('00000000-0000-0000-0000-000000000001', { children: [makeNode('00000000-0000-0000-0000-000000000002', { parent_uuid: '00000000-0000-0000-0000-000000000001' }), makeNode('00000000-0000-0000-0000-000000000003', { parent_uuid: '00000000-0000-0000-0000-000000000001' })] });
    queryClient.setQueryData(nodeKeys.detailBase('00000000-0000-0000-0000-000000000001'), root);

    const moved = makeNode('00000000-0000-0000-0000-000000000002', { parent_uuid: '00000000-0000-0000-0000-000000000001', sequence: 10 });
    writeMove(queryClient, '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 10, moved);

    const cached = queryClient.getQueryData<Node>(nodeKeys.detailBase('00000000-0000-0000-0000-000000000001'));
    const child = cached?.children?.find((c) => c.uuid === '00000000-0000-0000-0000-000000000002');
    expect(child).toBeDefined();
    expect(child?.parent_uuid).toBe('00000000-0000-0000-0000-000000000001');
  });
});
