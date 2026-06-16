/**
 * Tests for mutationMap.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Node } from '@/types/api';
import { operationToApiRequest, executeOperation } from '@/sync/mutationMap';
import { OperationRuntime, setOperationRuntime, getOperationRuntime } from '@/runtime';
import type { Operation } from '@/runtime';

function op(overrides: Partial<Operation> & { id: string; type: Operation['type']; blockId: string }): Operation {
  return {
    state: 'pending',
    dependsOn: [],
    retryCount: 0,
    maxRetries: 3,
    createdAt: Date.now(),
    payload: {} as Operation['payload'],
    ...overrides,
  } as Operation;
}

describe('operationToApiRequest', () => {
  it('builds a create request', () => {
    const operation = op({
      id: 'op-1',
      type: 'create',
      blockId: 'new-uuid',
      payload: {
        parentId: '1',
        afterBlockId: null,
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'hello' }] }],
      },
    });

    const request = operationToApiRequest(operation);
    expect(request).toEqual({
      type: 'create',
      data: {
        name: '[{"type":"paragraph","children":[{"type":"text","text":"hello"}]}]',
        parent_id: 1,
        sequence: 0,
        uuid: 'new-uuid',
      },
    });
  });

  it('builds an update_content request', () => {
    const operation = op({
      id: 'op-1',
      type: 'update_content',
      blockId: 'a',
      serverId: 42,
      payload: { contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'updated' }] }] },
    });

    const request = operationToApiRequest(operation);
    expect(request).toEqual({
      type: 'update',
      id: 42,
      data: { name: '[{"type":"paragraph","children":[{"type":"text","text":"updated"}]}]' },
    });
  });

  it('builds a move request', () => {
    const operation = op({
      id: 'op-1',
      type: 'move',
      blockId: 'a',
      serverId: 42,
      payload: { parentId: '7', afterBlockId: 'other' },
    });

    const request = operationToApiRequest(operation);
    expect(request).toEqual({
      type: 'update',
      id: 42,
      data: { parent_id: 7, sequence: 0 },
    });
  });

  it('builds a delete request', () => {
    const operation = op({ id: 'op-1', type: 'delete', blockId: 'a', serverId: 42, payload: {} });

    const request = operationToApiRequest(operation);
    expect(request).toEqual({ type: 'delete', id: 42 });
  });

  it('marks operations without serverId as unsupported', () => {
    const operation = op({
      id: 'op-1',
      type: 'update_content',
      blockId: 'a',
      payload: { contentAST: [] },
    });

    const request = operationToApiRequest(operation);
    expect(request).toEqual({ type: 'unsupported' });
  });
});

describe('executeOperation', () => {
  it('calls createNode API for create operations', async () => {
    const created: Node = {
      id: 99,
      uuid: 'new-uuid',
      name: 'created',
      icon: null,
      color: null,
      parent_id: 1,
      page_id: null,
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
    };

    const operation = op({
      id: 'op-1',
      type: 'create',
      blockId: 'new-uuid',
      payload: { parentId: '1', afterBlockId: null, contentAST: [] },
    });

    const result = await executeOperation(operation, api);

    expect(api.createNode).toHaveBeenCalledTimes(1);
    expect(result).toBe(created);
  });

  it('calls updateNode API for update_content operations', async () => {
    const updated: Node = {
      id: 42,
      uuid: 'a',
      name: 'updated',
      icon: null,
      color: null,
      parent_id: null,
      page_id: null,
      sequence: 0,
      collapsed: false,
      active: true,
      is_page: false,
      create_date: new Date().toISOString(),
      write_date: new Date().toISOString(),
    };
    const api = {
      createNode: vi.fn(),
      updateNode: vi.fn().mockResolvedValue(updated),
      deleteNode: vi.fn(),
    };

    const operation = op({
      id: 'op-1',
      type: 'update_content',
      blockId: 'a',
      serverId: 42,
      payload: { contentAST: [] },
    });

    const result = await executeOperation(operation, api);

    expect(api.updateNode).toHaveBeenCalledWith(42, { name: '[]' });
    expect(result).toBe(updated);
  });

  it('calls deleteNode API for delete operations', async () => {
    const api = {
      createNode: vi.fn(),
      updateNode: vi.fn(),
      deleteNode: vi.fn().mockResolvedValue(undefined),
    };

    const operation = op({ id: 'op-1', type: 'delete', blockId: 'a', serverId: 42, payload: {} });

    await executeOperation(operation, api);

    expect(api.deleteNode).toHaveBeenCalledWith(42);
  });
});

describe('operationToApiRequest with runtime state', () => {
  beforeEach(() => {
    setOperationRuntime(new OperationRuntime());
  });

  it('resolves the server id from the runtime when the operation lacks one', () => {
    const runtime = getOperationRuntime();
    runtime.loadBaseNodes([
      {
        blockId: 'runtime-block',
        serverId: 123,
        parentId: null,
        orderIndex: 0,
        nodeType: 'block',
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
        collapsed: false,
        isDeleted: false,
        isPage: false,
        name: '',
        icon: null,
        color: null,
        classIds: [],
        tagIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 0,
      },
    ]);

    const operation = op({
      id: 'op-1',
      type: 'update_content',
      blockId: 'runtime-block',
      payload: { contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'hi' }] }] },
    });

    const request = operationToApiRequest(operation);
    expect(request).toEqual({
      type: 'update',
      id: 123,
      data: { name: '[{"type":"paragraph","children":[{"type":"text","text":"hi"}]}]' },
    });
  });
});
