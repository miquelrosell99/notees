/**
 * Tests for MutationIntent → Operation adapters.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { MutationIntent } from '@/runtime/types';
import { OperationRuntime, setOperationRuntime, getOperationRuntime } from '@/runtime';
import { intentToOperations, contentOperation, createOperation, moveOperation, deleteOperation } from '@/sync/intents';

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
