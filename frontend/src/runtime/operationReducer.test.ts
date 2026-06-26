/**
 * Tests for the pure operation reducer.
 *
 * The reducer must never mutate its input and must produce predictable
 * graph states for every operation type.
 */

import { describe, it, expect } from 'vitest';
import type { Operation, CoreNode } from './operation';
import { applyOperation, applyOperations } from './operationReducer';

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

describe('applyOperation', () => {
  it('updates content without mutating input', () => {
    const nodes = new Map([['a', baseNode({ blockId: 'a' })]]);
    const operation = op({
      id: 'op-1',
      type: 'update_content',
      blockId: 'a',
      payload: { contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'hello' }] }] },
    });

    const result = applyOperation(nodes, operation, now);

    expect(result.get('a')?.contentAST).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: 'hello' }] },
    ]);
    expect(result.get('a')?.updatedAt).toBe(new Date(now).toISOString());
    expect(nodes.get('a')?.contentAST).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: '' }] },
    ]);
  });

  it('creates a node at the beginning when afterBlockId is null', () => {
    const nodes = new Map([
      ['a', baseNode({ blockId: 'a', parentId: 'root', orderIndex: 0 })],
    ]);
    const operation = op({
      id: 'op-1',
      type: 'create',
      blockId: 'b',
      payload: {
        parentId: 'root',
        afterBlockId: null,
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'new' }] }],
      },
    });

    const result = applyOperation(nodes, operation, now);

    expect(result.get('b')?.orderIndex).toBeLessThan(result.get('a')?.orderIndex ?? 0);
    expect(result.get('b')?.parentId).toBe('root');
  });

  it('creates a node after a sibling', () => {
    const nodes = new Map([
      ['a', baseNode({ blockId: 'a', parentId: 'root', orderIndex: 0 })],
      ['b', baseNode({ blockId: 'b', parentId: 'root', orderIndex: 1024 })],
    ]);
    const operation = op({
      id: 'op-1',
      type: 'create',
      blockId: 'c',
      payload: {
        parentId: 'root',
        afterBlockId: 'a',
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'between' }] }],
      },
    });

    const result = applyOperation(nodes, operation, now);

    const orderA = result.get('a')!.orderIndex;
    const orderC = result.get('c')!.orderIndex;
    const orderB = result.get('b')!.orderIndex;
    expect(orderA).toBeLessThan(orderC);
    expect(orderC).toBeLessThan(orderB);
  });

  it('moves a node to a new parent and computes order index', () => {
    const nodes = new Map([
      ['root', baseNode({ blockId: 'root', parentId: null, orderIndex: 0, isPage: true, nodeType: 'page' })],
      ['a', baseNode({ blockId: 'a', parentId: 'root', orderIndex: 0 })],
      ['b', baseNode({ blockId: 'b', parentId: 'other', orderIndex: 0 })],
    ]);
    const operation = op({
      id: 'op-1',
      type: 'move',
      blockId: 'b',
      payload: { parentId: 'root', afterBlockId: 'a' },
    });

    const result = applyOperation(nodes, operation, now);

    expect(result.get('b')?.parentId).toBe('root');
    expect(result.get('b')?.orderIndex).toBeGreaterThan(result.get('a')!.orderIndex);
  });

  it('marks a node as deleted without removing it from the graph', () => {
    const nodes = new Map([['a', baseNode({ blockId: 'a' })]]);
    const operation = op({ id: 'op-1', type: 'delete', blockId: 'a', payload: {} });

    const result = applyOperation(nodes, operation, now);

    expect(result.get('a')?.isDeleted).toBe(true);
    expect(result.has('a')).toBe(true);
  });

  it('sets collapsed state', () => {
    const nodes = new Map([['a', baseNode({ blockId: 'a', collapsed: false })]]);
    const operation = op({
      id: 'op-1',
      type: 'set_collapsed',
      blockId: 'a',
      payload: { collapsed: true },
    });

    const result = applyOperation(nodes, operation, now);

    expect(result.get('a')?.collapsed).toBe(true);
  });

  it('sets class ids', () => {
    const nodes = new Map([['a', baseNode({ blockId: 'a', classIds: ['1'] })]]);
    const operation = op({
      id: 'op-1',
      type: 'set_classes',
      blockId: 'a',
      payload: { classIds: ['1', '2'] },
    });

    const result = applyOperation(nodes, operation, now);

    expect(result.get('a')?.classIds).toEqual(['1', '2']);
  });

  it('sets tag ids', () => {
    const nodes = new Map([['a', baseNode({ blockId: 'a', tagIds: ['10'] })]]);
    const operation = op({
      id: 'op-1',
      type: 'set_tags',
      blockId: 'a',
      payload: { tagIds: ['10', '20'] },
    });

    const result = applyOperation(nodes, operation, now);

    expect(result.get('a')?.tagIds).toEqual(['10', '20']);
  });

  it('adds a class id', () => {
    const nodes = new Map([['a', baseNode({ blockId: 'a', classIds: ['1'] })]]);
    const operation = op({
      id: 'op-1',
      type: 'add_class',
      blockId: 'a',
      payload: { classId: '2' },
    });

    const result = applyOperation(nodes, operation, now);

    expect(result.get('a')?.classIds).toEqual(['1', '2']);
  });

  it('removes a class id', () => {
    const nodes = new Map([['a', baseNode({ blockId: 'a', classIds: ['1', '2'] })]]);
    const operation = op({
      id: 'op-1',
      type: 'remove_class',
      blockId: 'a',
      payload: { classId: '1' },
    });

    const result = applyOperation(nodes, operation, now);

    expect(result.get('a')?.classIds).toEqual(['2']);
  });

  it('adds a tag id', () => {
    const nodes = new Map([['a', baseNode({ blockId: 'a', tagIds: ['10'] })]]);
    const operation = op({
      id: 'op-1',
      type: 'add_tag',
      blockId: 'a',
      payload: { tagId: '20' },
    });

    const result = applyOperation(nodes, operation, now);

    expect(result.get('a')?.tagIds).toEqual(['10', '20']);
  });

  it('removes a tag id', () => {
    const nodes = new Map([['a', baseNode({ blockId: 'a', tagIds: ['10', '20'] })]]);
    const operation = op({
      id: 'op-1',
      type: 'remove_tag',
      blockId: 'a',
      payload: { tagId: '10' },
    });

    const result = applyOperation(nodes, operation, now);

    expect(result.get('a')?.tagIds).toEqual(['20']);
  });

  it('updates node fields', () => {
    const nodes = new Map([['a', baseNode({ blockId: 'a', icon: null, color: null })]]);
    const operation = op({
      id: 'op-1',
      type: 'update_node',
      blockId: 'a',
      payload: { updates: { icon: '⭐', color: 'red' } },
    });

    const result = applyOperation(nodes, operation, now);

    expect(result.get('a')?.icon).toBe('⭐');
    expect(result.get('a')?.color).toBe('red');
  });

  it('moves a node via move_node operation', () => {
    const nodes = new Map([
      ['root', baseNode({ blockId: 'root', parentId: null, orderIndex: 0, isPage: true, nodeType: 'page' })],
      ['a', baseNode({ blockId: 'a', parentId: 'other', orderIndex: 0 })],
      ['b', baseNode({ blockId: 'b', parentId: 'root', orderIndex: 0 })],
    ]);
    const operation = op({
      id: 'op-1',
      type: 'move_node',
      blockId: 'a',
      payload: { parentId: 'root', afterBlockId: 'b' },
    });

    const result = applyOperation(nodes, operation, now);

    expect(result.get('a')?.parentId).toBe('root');
    expect(result.get('a')?.orderIndex).toBeGreaterThan(result.get('b')!.orderIndex);
  });

  it('renormalizes siblings when the order gap becomes too small', () => {
    const nodes = new Map([
      ['a', baseNode({ blockId: 'a', parentId: 'root', orderIndex: 0 })],
      ['b', baseNode({ blockId: 'b', parentId: 'root', orderIndex: 1e-10 })],
    ]);
    const operation = op({
      id: 'op-1',
      type: 'create',
      blockId: 'c',
      payload: {
        parentId: 'root',
        afterBlockId: 'a',
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: ' squeezed ' }] }],
      },
    });

    const result = applyOperation(nodes, operation, now);

    const orderA = result.get('a')!.orderIndex;
    const orderC = result.get('c')!.orderIndex;
    const orderB = result.get('b')!.orderIndex;
    expect(orderA).toBeLessThan(orderC);
    expect(orderC).toBeLessThan(orderB);
    expect(orderB - orderA).toBeGreaterThanOrEqual(1);
  });

  it('applies a sequence of operations in order', () => {
    const nodes = new Map([
      ['root', baseNode({ blockId: 'root', parentId: null, orderIndex: 0, isPage: true, nodeType: 'page' })],
    ]);

    const operations: Operation[] = [
      op({
        id: 'op-1',
        type: 'create',
        blockId: 'a',
        payload: {
          parentId: 'root',
          afterBlockId: null,
          contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'A' }] }],
        },
      }),
      op({
        id: 'op-2',
        type: 'update_content',
        blockId: 'a',
        payload: { contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'A updated' }] }] },
      }),
      op({
        id: 'op-3',
        type: 'set_classes',
        blockId: 'a',
        payload: { classIds: ['class-1'] },
      }),
    ];

    const result = applyOperations(nodes, operations, now);

    expect(result.get('a')?.contentAST).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: 'A updated' }] },
    ]);
    expect(result.get('a')?.classIds).toEqual(['class-1']);
    expect(result.get('a')?.parentId).toBe('root');
  });

  it('ignores operations for unknown blocks except create', () => {
    const nodes = new Map<string, CoreNode>();
    const operation = op({
      id: 'op-1',
      type: 'update_content',
      blockId: 'missing',
      payload: { contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'x' }] }] },
    });

    const result = applyOperation(nodes, operation, now);

    expect(result.has('missing')).toBe(false);
  });
});
