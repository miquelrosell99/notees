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

function makeNode(overrides: Partial<Node> & { uuid: string }): Node {
  return {
    name: 'node',
    icon: null,
    color: null,
    parent_uuid: null,
    page_uuid: null,
    sequence: 0,
    collapsed: false,
    active: true,
    is_page: false,
    create_date: new Date().toISOString(),
    write_date: new Date().toISOString(),
    ...overrides,
  } as Node;
}

describe('operationToApiRequest', () => {
  it('builds a create request', () => {
    const operation = op({
      id: 'op-1',
      type: 'create',
      blockId: 'new-uuid',
      payload: {
        parentId: 'parent-uuid',
        afterBlockId: null,
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'hello' }] }],
      },
    });

    const request = operationToApiRequest(operation);
    expect(request).toEqual({
      type: 'create',
      data: {
        name: '[{"type":"paragraph","children":[{"type":"text","text":"hello"}]}]',
        parent_uuid: null,
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
      payload: { contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'updated' }] }] },
    });

    const request = operationToApiRequest(operation);
    expect(request).toEqual({
      type: 'update',
      uuid: 'a',
      data: { name: '[{"type":"paragraph","children":[{"type":"text","text":"updated"}]}]' },
    });
  });

  it('builds a move request', () => {
    const operation = op({
      id: 'op-1',
      type: 'move',
      blockId: 'a',
      payload: { parentId: '7', afterBlockId: 'other' },
    });

    const request = operationToApiRequest(operation);
    expect(request).toEqual({
      type: 'update',
      uuid: 'a',
      data: { parent_uuid: null, sequence: 0 },
    });
  });

  it('builds a delete request', () => {
    const operation = op({ id: 'op-1', type: 'delete', blockId: 'a', payload: {} });

    const request = operationToApiRequest(operation);
    expect(request).toEqual({ type: 'delete', uuid: 'a' });
  });

  it('builds an add_class request', () => {
    const operation = op({
      id: 'op-1',
      type: 'add_class',
      blockId: 'a',
      payload: { classId: '5' },
    });

    const request = operationToApiRequest(operation);
    expect(request).toEqual({ type: 'add_class', uuid: 'a', classUuid: '5' });
  });

  it('builds a remove_class request', () => {
    const operation = op({
      id: 'op-1',
      type: 'remove_class',
      blockId: 'a',
      payload: { classId: '5' },
    });

    const request = operationToApiRequest(operation);
    expect(request).toEqual({ type: 'remove_class', uuid: 'a', classUuid: '5' });
  });

  it('builds a move_node request', () => {
    const operation = op({
      id: 'op-1',
      type: 'move_node',
      blockId: 'a',
      payload: { parentId: '7', afterBlockId: null },
    });

    const request = operationToApiRequest(operation);
    expect(request).toEqual({ type: 'move_node', uuid: 'a', parentUuid: null, position: 0 });
  });

  it('uses the blockId as uuid when serverId is missing', () => {
    const operation = op({
      id: 'op-1',
      type: 'update_content',
      blockId: 'a',
      payload: { contentAST: [] },
    });

    const request = operationToApiRequest(operation);
    expect(request).toEqual({
      type: 'update',
      uuid: 'a',
      data: { name: '[]' },
    });
  });
});

describe('executeOperation', () => {
  it('calls createNode API for create operations', async () => {
    const created = makeNode({ uuid: 'new-uuid', name: 'created' });
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

    const operation = op({
      id: 'op-1',
      type: 'create',
      blockId: 'new-uuid',
      payload: { parentId: 'parent-uuid', afterBlockId: null, contentAST: [] },
    });

    const result = await executeOperation(operation, api);

    expect(api.createNode).toHaveBeenCalledTimes(1);
    expect(result).toBe(created);
  });

  it('calls updateNode API for update_content operations', async () => {
    const updated = makeNode({ uuid: 'a', name: 'updated' });
    const api = {
      createNode: vi.fn(),
      updateNode: vi.fn().mockResolvedValue(updated),
      deleteNode: vi.fn(),
      addClass: vi.fn(),
      removeClass: vi.fn(),
      addTag: vi.fn(),
      removeTag: vi.fn(),
      moveNode: vi.fn(),
    };

    const operation = op({
      id: 'op-1',
      type: 'update_content',
      blockId: 'a',
      payload: { contentAST: [] },
    });

    const result = await executeOperation(operation, api);

    expect(api.updateNode).toHaveBeenCalledWith('a', { name: '[]' });
    expect(result).toBe(updated);
  });

  it('calls deleteNode API for delete operations', async () => {
    const api = {
      createNode: vi.fn(),
      updateNode: vi.fn(),
      deleteNode: vi.fn().mockResolvedValue(undefined),
      addClass: vi.fn(),
      removeClass: vi.fn(),
      addTag: vi.fn(),
      removeTag: vi.fn(),
      moveNode: vi.fn(),
    };

    const operation = op({ id: 'op-1', type: 'delete', blockId: 'a', payload: {} });

    await executeOperation(operation, api);

    expect(api.deleteNode).toHaveBeenCalledWith('a');
  });

  it('calls addClass API for add_class operations', async () => {
    const updated = makeNode({ uuid: 'a', name: 'updated', classes_uuid: ['5'] });
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

    const operation = op({
      id: 'op-1',
      type: 'add_class',
      blockId: 'a',
      payload: { classId: '5' },
    });

    const result = await executeOperation(operation, api);

    expect(api.addClass).toHaveBeenCalledWith('a', '5');
    expect(result).toBe(updated);
  });

  it('calls moveNode API for move_node operations', async () => {
    const moved = makeNode({ uuid: 'a', name: 'moved', parent_uuid: 'parent-uuid-7', sequence: 1 });
    const api = {
      createNode: vi.fn(),
      updateNode: vi.fn(),
      deleteNode: vi.fn(),
      addClass: vi.fn(),
      removeClass: vi.fn(),
      addTag: vi.fn(),
      removeTag: vi.fn(),
      moveNode: vi.fn().mockResolvedValue(moved),
    };

    const operation = op({
      id: 'op-1',
      type: 'move_node',
      blockId: 'a',
      payload: { parentId: '7', afterBlockId: null },
    });

    const result = await executeOperation(operation, api);

    expect(api.moveNode).toHaveBeenCalledWith('a', null, 0);
    expect(result).toBe(moved);
  });
});

describe('operationToApiRequest with runtime state', () => {
  beforeEach(() => {
    setOperationRuntime(new OperationRuntime());
  });

  it('uses the runtime block id as uuid', () => {
    const runtime = getOperationRuntime();
    runtime.loadBaseNodes([
      {
        blockId: 'runtime-block',
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
      uuid: 'runtime-block',
      data: { name: '[{"type":"paragraph","children":[{"type":"text","text":"hi"}]}]' },
    });
  });
});
