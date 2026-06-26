/**
 * Tests for OperationRuntime.
 *
 * OperationRuntime must be a pure derived-state engine: no API calls,
 * no React, just base state + operations = projection.
 */

import { describe, it, expect, vi } from 'vitest';
import { OperationRuntime } from './OperationRuntime';
import type { CoreNode, Operation } from './operation';

const now = 1_700_000_000_000;

function baseNode(overrides: Partial<CoreNode> & { blockId: string }): CoreNode {
  return {
    blockId: overrides.blockId,
    parentId: overrides.parentId ?? null,
    orderIndex: overrides.orderIndex ?? 0,
    nodeType: overrides.nodeType ?? 'block',
    contentAST: overrides.contentAST ?? [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
    collapsed: overrides.collapsed ?? false,
    isDeleted: overrides.isDeleted ?? false,
    isPage: overrides.isPage ?? false,
    name: overrides.name,
    icon: overrides.icon ?? null,
    color: overrides.color ?? null,
    classIds: overrides.classIds ?? [],
    tagIds: overrides.tagIds ?? [],
    createdAt: overrides.createdAt ?? new Date(now - 10_000).toISOString(),
    updatedAt: overrides.updatedAt ?? new Date(now - 10_000).toISOString(),
    version: overrides.version ?? 1,
  };
}

function op(overrides: Partial<Operation> & { id: string; type: Operation['type']; blockId: string }): Operation {
  return {
    state: 'pending',
    dependsOn: [],
    retryCount: 0,
    maxRetries: 3,
    createdAt: now,
    payload: {} as Operation['payload'],
    ...overrides,
  } as Operation;
}

describe('OperationRuntime', () => {
  it('loads base nodes and exposes them in projection', () => {
    const runtime = new OperationRuntime();
    runtime.loadBaseNodes([baseNode({ blockId: 'a', contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'base' }] }] })]);

    expect(runtime.getNode('a')?.contentAST).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: 'base' }] },
    ]);
  });

  it('applies a local operation and updates projection', () => {
    const runtime = new OperationRuntime();
    runtime.loadBaseNodes([baseNode({ blockId: 'a' })]);

    runtime.applyOperation(
      op({
        id: 'op-1',
        type: 'update_content',
        blockId: 'a',
        payload: { contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'local' }] }] },
      }),
    );

    expect(runtime.getNode('a')?.contentAST).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: 'local' }] },
    ]);
    expect(runtime.getPendingOperations()).toHaveLength(1);
  });

  it('acknowledges an operation and keeps its effect until base state catches up', () => {
    const runtime = new OperationRuntime();
    runtime.loadBaseNodes([baseNode({ blockId: 'a' })]);
    runtime.applyOperation(
      op({
        id: 'op-1',
        type: 'update_content',
        blockId: 'a',
        payload: { contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'local' }] }] },
      }),
    );

    runtime.acknowledgeOperation('op-1');

    // Acknowledged operations stay in the runtime so the projection does not
    // snap back while we wait for the fresh base state to arrive.
    expect(runtime.getOperations()).toHaveLength(1);
    expect(runtime.getOperations()[0].state).toBe('acknowledged');
    expect(runtime.getNode('a')?.contentAST).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: 'local' }] },
    ]);

    // Once the base state is updated, the acknowledged operation is removed.
    runtime.upsertBaseNodes([
      baseNode({
        blockId: 'a',
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'local' }] }],
      }),
    ]);
    expect(runtime.getOperations()).toHaveLength(0);
  });

  it('preserves structural changes across acknowledge until base state catches up', () => {
    const runtime = new OperationRuntime();
    runtime.loadBaseNodes([
      baseNode({ blockId: 'root' }),
      baseNode({ blockId: 'a', parentId: 'root' }),
    ]);
    runtime.applyOperation(
      op({
        id: 'op-move',
        type: 'move',
        blockId: 'a',
        payload: { parentId: 'root', afterBlockId: null },
      }),
    );

    // Simulate SyncManager: server acks the move before fresh base nodes arrive.
    runtime.acknowledgeOperation('op-move');

    // The structural change must not snap back while waiting for the base update.
    expect(runtime.getOperations()).toHaveLength(1);
    expect(runtime.getOperations()[0].state).toBe('acknowledged');
    expect(runtime.getNode('a')?.parentId).toBe('root');

    // Fresh base state arrives and absorbs the acknowledged operation.
    runtime.upsertBaseNodes([baseNode({ blockId: 'a', parentId: 'root' })]);
    expect(runtime.getOperations()).toHaveLength(0);
    expect(runtime.getNode('a')?.parentId).toBe('root');
  });

  it('does not acknowledge an unknown operation', () => {
    const runtime = new OperationRuntime();
    runtime.acknowledgeOperation('missing');
    expect(runtime.getOperations()).toHaveLength(0);
  });

  it('fails an operation and allows retry', () => {
    const runtime = new OperationRuntime();
    runtime.loadBaseNodes([baseNode({ blockId: 'a' })]);
    runtime.applyOperation(
      op({ id: 'op-1', type: 'delete', blockId: 'a', payload: {} }),
    );

    runtime.failOperation('op-1', 'network error');

    const failed = runtime.getOperations()[0];
    expect(failed.state).toBe('failed');
    expect(failed.error).toBe('network error');
    expect(failed.retryCount).toBe(1);

    runtime.retryOperation('op-1');

    expect(runtime.getOperations()[0].state).toBe('pending');
  });

  it('cancels a pending operation but not an in-flight one', () => {
    const runtime = new OperationRuntime();
    runtime.loadBaseNodes([baseNode({ blockId: 'a' })]);
    runtime.applyOperation(
      op({ id: 'op-1', type: 'set_classes', blockId: 'a', payload: { classIds: ['1'] } }),
    );

    runtime.cancelOperation('op-1');
    expect(runtime.getOperations()).toHaveLength(0);

    runtime.applyOperation(
      op({ id: 'op-2', type: 'set_classes', blockId: 'a', payload: { classIds: ['2'] }, state: 'in_flight' }),
    );
    runtime.cancelOperation('op-2');
    expect(runtime.getOperations()).toHaveLength(1);
  });

  it('returns dispatchable operations respecting dependencies', () => {
    const runtime = new OperationRuntime();
    runtime.loadBaseNodes([baseNode({ blockId: 'root', isPage: true, nodeType: 'page' })]);

    runtime.applyOperation(
      op({
        id: 'op-create',
        type: 'create',
        blockId: 'a',
        payload: {
          parentId: 'root',
          afterBlockId: null,
          contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'A' }] }],
        },
      }),
    );
    runtime.applyOperation(
      op({
        id: 'op-content',
        type: 'update_content',
        blockId: 'a',
        payload: { contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'A updated' }] }] },
        dependsOn: ['op-create'],
      }),
    );

    expect(runtime.getDispatchableOperations().map((o) => o.id)).toEqual(['op-create']);

    runtime.acknowledgeOperation('op-create');

    expect(runtime.getDispatchableOperations().map((o) => o.id)).toEqual(['op-content']);
  });

  it('reports pending changes per block and field', () => {
    const runtime = new OperationRuntime();
    runtime.loadBaseNodes([baseNode({ blockId: 'a' })]);
    runtime.applyOperation(
      op({ id: 'op-1', type: 'update_content', blockId: 'a', payload: { contentAST: [] } }),
    );

    expect(runtime.hasPendingChange('a', 'contentAST')).toBe(true);
    expect(runtime.hasPendingChange('a', 'parentId')).toBe(false);
    expect(runtime.hasPendingChange('a')).toBe(true);
    expect(runtime.hasPendingChange('missing')).toBe(false);
  });

  it('returns children sorted by order index', () => {
    const runtime = new OperationRuntime();
    runtime.loadBaseNodes([
      baseNode({ blockId: 'root', isPage: true, nodeType: 'page' }),
      baseNode({ blockId: 'b', parentId: 'root', orderIndex: 10 }),
      baseNode({ blockId: 'a', parentId: 'root', orderIndex: 5 }),
    ]);

    const children = runtime.getChildren('root');
    expect(children.map((c) => c.blockId)).toEqual(['a', 'b']);
  });

  it('excludes deleted nodes from children', () => {
    const runtime = new OperationRuntime();
    runtime.loadBaseNodes([
      baseNode({ blockId: 'root', isPage: true, nodeType: 'page' }),
      baseNode({ blockId: 'a', parentId: 'root' }),
    ]);
    runtime.applyOperation(op({ id: 'op-1', type: 'delete', blockId: 'a', payload: {} }));

    expect(runtime.getChildren('root')).toHaveLength(0);
    expect(runtime.getNode('a')?.isDeleted).toBe(true);
  });

  it('keeps acknowledged effect when base state is updated first', () => {
    const runtime = new OperationRuntime();
    runtime.loadBaseNodes([baseNode({ blockId: 'a' })]);
    runtime.applyOperation(
      op({
        id: 'op-1',
        type: 'update_content',
        blockId: 'a',
        payload: { contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'local' }] }] },
      }),
    );

    // SyncManager updates base state from server response, then acknowledges.
    runtime.upsertBaseNodes([
      baseNode({
        blockId: 'a',
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'local' }] }],
      }),
    ]);
    runtime.acknowledgeOperation('op-1');

    expect(runtime.getOperations()).toHaveLength(0);
    expect(runtime.getNode('a')?.contentAST).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: 'local' }] },
    ]);
  });

  it('notifies subscribers on every change', () => {
    const runtime = new OperationRuntime();
    const listener = vi.fn();
    runtime.subscribe(listener);

    runtime.loadBaseNodes([baseNode({ blockId: 'a' })]);
    expect(listener).toHaveBeenCalledTimes(1);

    runtime.applyOperation(op({ id: 'op-1', type: 'delete', blockId: 'a', payload: {} }));
    expect(listener).toHaveBeenCalledTimes(2);

    runtime.acknowledgeOperation('op-1');
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('merges base node updates with local operations', () => {
    const runtime = new OperationRuntime();
    runtime.loadBaseNodes([baseNode({ blockId: 'a', contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'server' }] }] })]);
    runtime.applyOperation(
      op({
        id: 'op-1',
        type: 'update_content',
        blockId: 'a',
        payload: { contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'local' }] }] },
      }),
    );

    // Simulate a refetch that updates a different field (color) while content is still pending.
    runtime.upsertBaseNodes([
      baseNode({
        blockId: 'a',
        color: 'red',
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'server' }] }],
      }),
    ]);

    const node = runtime.getNode('a')!;
    expect(node.color).toBe('red');
    expect(node.contentAST).toEqual([{ type: 'paragraph', children: [{ type: 'text', text: 'local' }] }]);
  });
});
