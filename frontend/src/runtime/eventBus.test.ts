/**
 * Tests for RuntimeEventBus change-detection semantics.
 *
 * The bus must emit `nodes_changed` for content-only edits and
 * `structure_changed` only when the tree shape actually changes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OperationRuntime } from './OperationRuntime';
import { setOperationRuntime } from './runtimeInstance';
import { resetRuntimeEventBus, getRuntimeEventBus } from './eventBus';
import type { CoreNode, Operation } from './operation';
import type { RuntimeEvent } from './types';

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
    name: overrides.name ?? '',
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

describe('RuntimeEventBus change detection', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  function setup() {
    const runtime = new OperationRuntime();
    setOperationRuntime(runtime);
    resetRuntimeEventBus(runtime);
    const events: RuntimeEvent[] = [];
    const unsubscribe = getRuntimeEventBus(runtime).subscribe((event) => events.push(event));
    return { runtime, events, unsubscribe };
  }

  it('emits nodes_changed but not structure_changed for a content-only edit', () => {
    const { runtime, events, unsubscribe } = setup();
    runtime.loadBaseNodes([baseNode({ blockId: 'a', parentId: 'root' })]);
    getRuntimeEventBus(runtime).flushEvents();
    events.length = 0;

    runtime.applyOperation(
      op({
        id: 'op-1',
        type: 'update_content',
        blockId: 'a',
        payload: { contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'edited' }] }] },
      }),
    );
    getRuntimeEventBus(runtime).flushEvents();

    expect(events.some((e) => e.type === 'nodes_changed')).toBe(true);
    expect(events.some((e) => e.type === 'structure_changed')).toBe(false);
    unsubscribe();
  });

  it('emits structure_changed when a new block is created', () => {
    const { runtime, events, unsubscribe } = setup();
    runtime.loadBaseNodes([baseNode({ blockId: 'root', isPage: true, nodeType: 'page' })]);
    getRuntimeEventBus(runtime).flushEvents();
    events.length = 0;

    runtime.applyOperation(
      op({
        id: 'op-1',
        type: 'create',
        blockId: 'child',
        payload: {
          parentId: 'root',
          afterBlockId: null,
          contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'new' }] }],
        },
      }),
    );
    getRuntimeEventBus(runtime).flushEvents();

    const structureEvent = events.find((e) => e.type === 'structure_changed');
    expect(structureEvent).toBeDefined();
    expect(structureEvent?.type === 'structure_changed' && structureEvent.parentIds).toContain('root');
    unsubscribe();
  });

  it('emits structure_changed for both old and new parents when a block moves', () => {
    const { runtime, events, unsubscribe } = setup();
    runtime.loadBaseNodes([
      baseNode({ blockId: 'root', isPage: true, nodeType: 'page' }),
      baseNode({ blockId: 'a', parentId: 'root' }),
      baseNode({ blockId: 'b', parentId: 'root' }),
    ]);
    getRuntimeEventBus(runtime).flushEvents();
    events.length = 0;

    runtime.applyOperation(
      op({
        id: 'op-1',
        type: 'move',
        blockId: 'a',
        payload: { parentId: 'b', afterBlockId: null },
      }),
    );
    getRuntimeEventBus(runtime).flushEvents();

    const structureEvent = events.find((e) => e.type === 'structure_changed');
    expect(structureEvent).toBeDefined();
    expect(structureEvent?.type === 'structure_changed' && structureEvent.parentIds).toContain('root');
    expect(structureEvent?.type === 'structure_changed' && structureEvent.parentIds).toContain('b');
    unsubscribe();
  });

  it('emits collapse_changed and structure_changed when collapsed changes', () => {
    const { runtime, events, unsubscribe } = setup();
    runtime.loadBaseNodes([
      baseNode({ blockId: 'root', isPage: true, nodeType: 'page' }),
      baseNode({ blockId: 'a', parentId: 'root' }),
    ]);
    getRuntimeEventBus(runtime).flushEvents();
    events.length = 0;

    runtime.applyOperation(
      op({
        id: 'op-1',
        type: 'set_collapsed',
        blockId: 'a',
        payload: { collapsed: true },
      }),
    );
    getRuntimeEventBus(runtime).flushEvents();

    expect(events.some((e) => e.type === 'collapse_changed')).toBe(true);
    const structureEvent = events.find((e) => e.type === 'structure_changed');
    expect(structureEvent).toBeDefined();
    expect(structureEvent?.type === 'structure_changed' && structureEvent.parentIds).toContain('root');
    unsubscribe();
  });

  it('emits structure_changed when a block is deleted', () => {
    const { runtime, events, unsubscribe } = setup();
    runtime.loadBaseNodes([
      baseNode({ blockId: 'root', isPage: true, nodeType: 'page' }),
      baseNode({ blockId: 'a', parentId: 'root' }),
    ]);
    getRuntimeEventBus(runtime).flushEvents();
    events.length = 0;

    runtime.applyOperation(op({ id: 'op-1', type: 'delete', blockId: 'a', payload: {} }));
    getRuntimeEventBus(runtime).flushEvents();

    const structureEvent = events.find((e) => e.type === 'structure_changed');
    expect(structureEvent).toBeDefined();
    expect(structureEvent?.type === 'structure_changed' && structureEvent.parentIds).toContain('root');
    unsubscribe();
  });
});
