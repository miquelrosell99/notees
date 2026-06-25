/**
 * Integration tests for SyncManager.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import { OperationRuntime, setOperationRuntime, getOperationRuntime } from '@/runtime';
import type { CoreNode } from '@/runtime';
import { SyncManager } from '@/sync/SyncManager';
import { nodeKeys } from '@/hooks/queryKeys';

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('SyncManager', () => {
  beforeEach(() => {
    setOperationRuntime(new OperationRuntime());
  });

  afterEach(() => {
    setOperationRuntime(null);
  });

  it('dispatches a create operation and acknowledges it on success', async () => {
    const runtime = getOperationRuntime();
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });

    const parent: Node = {
      id: 1,
      uuid: 'parent-uuid',
      name: 'parent',
      icon: null,
      color: null,
      parent_id: null,
      parent_uuid: null,
      page_id: null,
      page_uuid: null,
      sequence: 0,
      collapsed: false,
      active: true,
      is_page: true,
      create_date: new Date().toISOString(),
      write_date: new Date().toISOString(),
      children: [],
    };
    queryClient.setQueryData(nodeKeys.detailBase(1), parent);

    const created: Node = {
      id: 99,
      uuid: 'new-uuid',
      name: 'created',
      icon: null,
      color: null,
      parent_id: 1,
      parent_uuid: 'parent-uuid',
      page_id: null,
      page_uuid: null,
      sequence: 0,
      collapsed: false,
      active: true,
      is_page: false,
      create_date: new Date().toISOString(),
      write_date: new Date().toISOString(),
    };

    const api = {
      createNode: vi.fn().mockResolvedValue(created),
      updateNode: vi.fn(),
      deleteNode: vi.fn(),
      addClass: vi.fn(),
      removeClass: vi.fn(),
      addTag: vi.fn(),
      removeTag: vi.fn(),
      moveNode: vi.fn(),
    };

    render(<SyncManager api={api} />, { wrapper: wrapper(queryClient) });

    runtime.applyOperation({
      id: 'op-create',
      type: 'create',
      blockId: 'new-uuid',
      serverId: undefined,
      state: 'pending',
      dependsOn: [],
      retryCount: 0,
      maxRetries: 3,
      createdAt: Date.now(),
      payload: {
        parentId: '1',
        afterBlockId: null,
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'hello' }] }],
      },
    });

    await waitFor(() => expect(api.createNode).toHaveBeenCalledTimes(1));
    // The operation is marked acknowledged but stays in the runtime until the
    // next base-state update absorbs it.
    await waitFor(() => {
      const ops = runtime.getOperations();
      expect(ops).toHaveLength(1);
      expect(ops[0].state).toBe('acknowledged');
    });

    const cached = queryClient.getQueryData<Node>(nodeKeys.detailBase(1));
    expect(cached?.children?.some((c) => c.id === 99)).toBe(true);

    // Simulate the base-state sync that normally happens via useRuntimeSync /
    // useBlockTree: once the created node is upserted into base, the operation
    // is removed.
    runtime.upsertBaseNodes([
      {
        blockId: created.uuid,
        serverId: created.id,
        parentId: String(created.parent_id),
        orderIndex: created.sequence ?? 0,
        nodeType: 'block',
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'hello' }] }],
        collapsed: false,
        isDeleted: false,
        isPage: false,
        name: 'created',
        icon: null,
        color: null,
        classIds: [],
        tagIds: [],
        createdAt: created.create_date,
        updatedAt: created.write_date,
        version: 1,
      } as CoreNode,
    ]);
    expect(runtime.getOperations()).toHaveLength(0);
  });

  it('dispatches an add_class operation and acknowledges it on success', async () => {
    const runtime = getOperationRuntime();
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });

    runtime.loadBaseNodes([
      {
        blockId: 'node-uuid',
        serverId: 42,
        parentId: null,
        orderIndex: 0,
        nodeType: 'block',
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'hello' }] }],
        collapsed: false,
        isDeleted: false,
        isPage: false,
        name: 'hello',
        icon: null,
        color: null,
        classIds: [],
        tagIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      } as CoreNode,
    ]);

    const updated: Node = {
      id: 42,
      uuid: 'node-uuid',
      name: 'hello',
      icon: null,
      color: 'red',
      parent_id: null,
      parent_uuid: null,
      page_id: null,
      page_uuid: null,
      sequence: 0,
      collapsed: false,
      active: true,
      is_page: false,
      classes: [5],
      create_date: new Date().toISOString(),
      write_date: new Date().toISOString(),
    };

    const api = {
      createNode: vi.fn(),
      updateNode: vi.fn(),
      deleteNode: vi.fn(),
      addClass: vi.fn().mockResolvedValue(updated),
      removeClass: vi.fn(),
      addTag: vi.fn(),
      removeTag: vi.fn(),
      moveNode: vi.fn(),
    };

    render(<SyncManager api={api} />, { wrapper: wrapper(queryClient) });

    runtime.applyOperation({
      id: 'op-add-class',
      type: 'add_class',
      blockId: 'node-uuid',
      serverId: 42,
      state: 'pending',
      dependsOn: [],
      retryCount: 0,
      maxRetries: 3,
      createdAt: Date.now(),
      payload: { classId: '5' },
    });

    await waitFor(() => expect(api.addClass).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const ops = runtime.getOperations();
      expect(ops).toHaveLength(1);
      expect(ops[0].state).toBe('acknowledged');
    });

    expect(api.addClass).toHaveBeenCalledWith('node-uuid', '5');
  });

  it('reports operation failure to the runtime', async () => {
    const runtime = getOperationRuntime();
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });

    const api = {
      createNode: vi.fn().mockRejectedValue(new Error('boom')),
      updateNode: vi.fn(),
      deleteNode: vi.fn(),
      addClass: vi.fn(),
      removeClass: vi.fn(),
      addTag: vi.fn(),
      removeTag: vi.fn(),
      moveNode: vi.fn(),
    };

    render(<SyncManager api={api} />, { wrapper: wrapper(queryClient) });

    runtime.applyOperation({
      id: 'op-create',
      type: 'create',
      blockId: 'new-uuid',
      state: 'pending',
      dependsOn: [],
      retryCount: 0,
      maxRetries: 3,
      createdAt: Date.now(),
      payload: {
        parentId: '1',
        afterBlockId: null,
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'hello' }] }],
      },
    });

    await waitFor(() => expect(api.createNode).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const ops = runtime.getOperations();
      expect(ops).toHaveLength(1);
      expect(ops[0].state).toBe('failed');
      expect(ops[0].error).toBe('boom');
    });
  });
});
