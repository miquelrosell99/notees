/**
 * Tests for MutationIntent → Operation adapters.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { MutationIntent } from '@/runtime/types';
import { OperationRuntime, setOperationRuntime, getOperationRuntime } from '@/runtime';
import {
  intentToOperations,
  contentOperation,
  createOperation,
  moveOperation,
  deleteOperation,
  addClassOperation,
  removeClassOperation,
  addTagOperation,
  removeTagOperation,
  updateNodeOperation,
  moveNodeOperation,
} from '@/sync/intents';

function makeRuntime(): OperationRuntime {
  const runtime = new OperationRuntime();
  runtime.loadBaseNodes([
    {
      blockId: 'server-block',
      serverId: 42,
      parentId: null,
      orderIndex: 0,
      nodeType: 'block',
      contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
      collapsed: false,
      isDeleted: false,
      isPage: false,
      classIds: [],
      tagIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    },
  ]);
  return runtime;
}

describe('intentToOperations', () => {
  it('converts update_content to an operation', () => {
    const runtime = makeRuntime();
    const intent: MutationIntent = {
      type: 'update_content',
      blockId: 'server-block',
      contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'hi' }] }],
    };

    const ops = intentToOperations(intent, runtime);

    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('update_content');
    expect(ops[0].serverId).toBe(42);
    expect(ops[0].payload).toEqual({ contentAST: intent.contentAST });
  });

  it('converts create_block to an operation', () => {
    const runtime = makeRuntime();
    const intent: MutationIntent = {
      type: 'create_block',
      blockId: 'new-block',
      parentId: 'parent-uuid',
      afterBlockId: null,
      contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'new' }] }],
    };

    const ops = intentToOperations(intent, runtime);

    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('create');
    expect(ops[0].payload).toMatchObject({ parentId: 'parent-uuid', afterBlockId: null });
  });

  it('converts delete_block to an operation', () => {
    const runtime = makeRuntime();
    const intent: MutationIntent = { type: 'delete_block', blockId: 'server-block' };

    const ops = intentToOperations(intent, runtime);

    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('delete');
    expect(ops[0].serverId).toBe(42);
  });

  it('converts move_block to an operation', () => {
    const runtime = makeRuntime();
    const intent: MutationIntent = {
      type: 'move_block',
      blockId: 'server-block',
      newParentId: 'new-parent',
      afterBlockId: 'sibling',
    };

    const ops = intentToOperations(intent, runtime);

    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('move');
    expect(ops[0].payload).toEqual({ parentId: 'new-parent', afterBlockId: 'sibling' });
  });

  it('flattens batch intents', () => {
    const runtime = makeRuntime();
    const intent: MutationIntent = {
      type: 'batch',
      intents: [
        { type: 'delete_block', blockId: 'server-block' },
        { type: 'update_content', blockId: 'server-block', contentAST: [] },
      ],
    };

    const ops = intentToOperations(intent, runtime);

    expect(ops).toHaveLength(2);
    expect(ops.map((o) => o.type)).toEqual(['delete', 'update_content']);
  });

  it('converts add_class to an operation', () => {
    const runtime = makeRuntime();
    const intent: MutationIntent = { type: 'add_class', blockId: 'server-block', classId: '5' };

    const ops = intentToOperations(intent, runtime);

    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('add_class');
    expect(ops[0].serverId).toBe(42);
    expect(ops[0].payload).toEqual({ classId: '5' });
  });

  it('converts remove_class to an operation', () => {
    const runtime = makeRuntime();
    const intent: MutationIntent = { type: 'remove_class', blockId: 'server-block', classId: '5' };

    const ops = intentToOperations(intent, runtime);

    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('remove_class');
  });

  it('converts add_tag to an operation', () => {
    const runtime = makeRuntime();
    const intent: MutationIntent = { type: 'add_tag', blockId: 'server-block', tagId: '10' };

    const ops = intentToOperations(intent, runtime);

    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('add_tag');
  });

  it('converts remove_tag to an operation', () => {
    const runtime = makeRuntime();
    const intent: MutationIntent = { type: 'remove_tag', blockId: 'server-block', tagId: '10' };

    const ops = intentToOperations(intent, runtime);

    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('remove_tag');
  });

  it('converts update_node to an operation', () => {
    const runtime = makeRuntime();
    const intent: MutationIntent = {
      type: 'update_node',
      blockId: 'server-block',
      updates: { icon: '⭐' },
    };

    const ops = intentToOperations(intent, runtime);

    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('update_node');
    expect(ops[0].payload).toEqual({ updates: { icon: '⭐' } });
  });

  it('converts move_node to an operation', () => {
    const runtime = makeRuntime();
    const intent: MutationIntent = {
      type: 'move_node',
      blockId: 'server-block',
      parentId: 'new-parent',
      afterBlockId: null,
    };

    const ops = intentToOperations(intent, runtime);

    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('move_node');
    expect(ops[0].payload).toEqual({ parentId: 'new-parent', afterBlockId: null });
  });
});

describe('operation factories', () => {
  it('contentOperation includes server id when provided', () => {
    const op = contentOperation('a', 7, [{ type: 'paragraph', children: [{ type: 'text', text: 'x' }] }]);
    expect(op.blockId).toBe('a');
    expect(op.serverId).toBe(7);
    expect(op.type).toBe('update_content');
  });

  it('createOperation preserves payload fields', () => {
    const op = createOperation('new', {
      parentId: 'p',
      afterBlockId: null,
      contentAST: [],
      nodeType: 'block',
    });
    expect(op.type).toBe('create');
    expect(op.payload).toMatchObject({ parentId: 'p', nodeType: 'block' });
  });

  it('moveOperation stores parent and after block', () => {
    const op = moveOperation('a', 1, 'p', 'b');
    expect(op.type).toBe('move');
    expect(op.payload).toEqual({ parentId: 'p', afterBlockId: 'b' });
  });

  it('deleteOperation stores server id', () => {
    const op = deleteOperation('a', 99);
    expect(op.type).toBe('delete');
    expect(op.serverId).toBe(99);
  });

  it('addClassOperation stores class id', () => {
    const op = addClassOperation('a', 99, '5');
    expect(op.type).toBe('add_class');
    expect(op.serverId).toBe(99);
    expect(op.payload).toEqual({ classId: '5' });
  });

  it('removeClassOperation stores class id', () => {
    const op = removeClassOperation('a', 99, '5');
    expect(op.type).toBe('remove_class');
    expect(op.payload).toEqual({ classId: '5' });
  });

  it('addTagOperation stores tag id', () => {
    const op = addTagOperation('a', 99, '10');
    expect(op.type).toBe('add_tag');
    expect(op.payload).toEqual({ tagId: '10' });
  });

  it('removeTagOperation stores tag id', () => {
    const op = removeTagOperation('a', 99, '10');
    expect(op.type).toBe('remove_tag');
    expect(op.payload).toEqual({ tagId: '10' });
  });

  it('updateNodeOperation stores updates', () => {
    const op = updateNodeOperation('a', 99, { icon: '⭐' });
    expect(op.type).toBe('update_node');
    expect(op.payload).toEqual({ updates: { icon: '⭐' } });
  });

  it('moveNodeOperation stores parent and after block', () => {
    const op = moveNodeOperation('a', 99, 'p', 'b');
    expect(op.type).toBe('move_node');
    expect(op.payload).toEqual({ parentId: 'p', afterBlockId: 'b' });
  });
});

describe('intentToOperations with runtime state', () => {
  beforeEach(() => {
    setOperationRuntime(new OperationRuntime());
  });

  it('makes update_content depend on a pending create for the same block', () => {
    const runtime = getOperationRuntime();
    const blockId = 'unpersisted-block';
    runtime.applyOperation({
      id: 'create-op',
      type: 'create',
      blockId,
      state: 'pending',
      dependsOn: [],
      retryCount: 0,
      maxRetries: 3,
      createdAt: Date.now(),
      payload: {
        parentId: null,
        afterBlockId: null,
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
      },
    });

    const intent: MutationIntent = {
      type: 'update_content',
      blockId,
      contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'hello' }] }],
    };

    const ops = intentToOperations(intent, runtime);

    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('update_content');
    expect(ops[0].serverId).toBeUndefined();
    expect(ops[0].dependsOn).toContain('create-op');
  });
});
