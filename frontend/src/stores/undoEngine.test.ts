/**
 * Tests for UndoEngine reverse-intent computation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OperationRuntime, setOperationRuntime, getOperationRuntime } from '@/runtime';
import { getUndoEngine, resetUndoEngine } from './undoEngine';
import type { MutationIntent } from '@/runtime/types';

import type { CoreNode } from '@/runtime';

function loadNode(runtime: OperationRuntime, overrides: Partial<CoreNode> & { blockId: string }) {
  runtime.loadBaseNodes([
    {
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    },
  ]);
}

describe('UndoEngine reverse intents', () => {
  beforeEach(() => {
    setOperationRuntime(new OperationRuntime());
    resetUndoEngine();
  });

  it('reverses add_class with remove_class', async () => {
    const runtime = getOperationRuntime();
    loadNode(runtime, { blockId: 'a' });
    const engine = getUndoEngine();

    const intent: MutationIntent = { type: 'add_class', blockId: 'a', classId: '5' };
    const entry = await engine.applyIntent(intent);

    expect(entry?.reverse).toEqual({ type: 'remove_class', blockId: 'a', classId: '5' });
  });

  it('reverses remove_class with add_class', async () => {
    const runtime = getOperationRuntime();
    loadNode(runtime, { blockId: 'a', classIds: ['5'] });
    const engine = getUndoEngine();

    const intent: MutationIntent = { type: 'remove_class', blockId: 'a', classId: '5' };
    const entry = await engine.applyIntent(intent);

    expect(entry?.reverse).toEqual({ type: 'add_class', blockId: 'a', classId: '5' });
  });

  it('reverses add_tag with remove_tag', async () => {
    const runtime = getOperationRuntime();
    loadNode(runtime, { blockId: 'a' });
    const engine = getUndoEngine();

    const intent: MutationIntent = { type: 'add_tag', blockId: 'a', tagId: '10' };
    const entry = await engine.applyIntent(intent);

    expect(entry?.reverse).toEqual({ type: 'remove_tag', blockId: 'a', tagId: '10' });
  });

  it('reverses update_node with original field values', async () => {
    const runtime = getOperationRuntime();
    loadNode(runtime, { blockId: 'a', icon: '🔴', color: 'red' });
    const engine = getUndoEngine();

    const intent: MutationIntent = { type: 'update_node', blockId: 'a', updates: { icon: '⭐' } };
    const entry = await engine.applyIntent(intent);

    expect(entry?.reverse).toMatchObject({
      type: 'update_node',
      blockId: 'a',
      updates: { icon: '🔴' },
    });
  });

  it('reverses move_node with original parent and position', async () => {
    const runtime = getOperationRuntime();
    loadNode(runtime, { blockId: 'root', isPage: true, nodeType: 'page' });
    loadNode(runtime, { blockId: 'a', parentId: 'root', orderIndex: 0 });
    const engine = getUndoEngine();

    const intent: MutationIntent = {
      type: 'move_node',
      blockId: 'a',
      parentId: 'new-parent',
      afterBlockId: null,
    };
    const entry = await engine.applyIntent(intent);

    expect(entry?.reverse).toMatchObject({
      type: 'move_node',
      blockId: 'a',
      parentId: 'root',
    });
  });
});
