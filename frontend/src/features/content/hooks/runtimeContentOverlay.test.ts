/**
 * Tests for runtimeContentOverlay — the read-only projection of live runtime
 * content onto a query-cache node.
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { OperationRuntime } from '@/runtime';
import type { Operation } from '@/runtime';
import { getRuntimeEventBus, resetRuntimeEventBus } from '@/runtime/eventBus';
import type { Node } from '@/types';
import {
  overlayRuntimeContent,
  getRuntimeDisplayName,
  readRuntimeName,
  useRuntimeDisplayName,
} from './runtimeContentOverlay';

const PAGE_UUID = '11111111-1111-1111-1111-111111111111';
const BLOCK_UUID = '22222222-2222-2222-2222-222222222222';

function makePropNode(overrides: Partial<Node> = {}): Node {
  return {
    uuid: BLOCK_UUID,
    name: '[{"type":"paragraph","children":[{"type":"text","text":""}]}]',
    icon: null,
    color: null,
    parent_uuid: PAGE_UUID,
    page_uuid: null,
    sequence: 0,
    active: true,
    is_page: false,
    is_deleted: false,
    has_children: false,
    children: [],
    create_date: new Date().toISOString(),
    write_date: new Date().toISOString(),
    classes_uuid: [],
    tags_uuid: [],
    properties_uuid: {},
    ...overrides,
  };
}

function loadBase(runtime: OperationRuntime): void {
  runtime.loadBaseNodes([
    {
      blockId: BLOCK_UUID,
      parentId: PAGE_UUID,
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
      version: 1,
    },
  ]);
}

function applyContent(runtime: OperationRuntime, text: string): void {
  runtime.applyOperation({
    id: 'update-op',
    type: 'update_content',
    blockId: BLOCK_UUID,
    state: 'pending',
    dependsOn: [],
    retryCount: 0,
    maxRetries: 3,
    createdAt: Date.now(),
    payload: {
      contentAST: [{ type: 'paragraph', children: [{ type: 'text', text }] }],
    },
  } as Operation);
}

describe('overlayRuntimeContent', () => {
  it('overlays live runtime content onto a stale query-cache node', () => {
    const runtime = new OperationRuntime();
    loadBase(runtime);
    applyContent(runtime, 'typed content');

    const staleNode = makePropNode();
    const projected = overlayRuntimeContent(runtime, staleNode);

    expect(projected.name).toBe(
      '[{"type":"paragraph","children":[{"type":"text","text":"typed content"}]}]',
    );
    // The original query-cache node is not mutated.
    expect(staleNode.name).toBe('[{"type":"paragraph","children":[{"type":"text","text":""}]}]');
  });

  it('returns the node unchanged when no runtime projection exists', () => {
    const runtime = new OperationRuntime();
    const node = makePropNode();
    expect(overlayRuntimeContent(runtime, node)).toBe(node);
  });
});

describe('getRuntimeDisplayName', () => {
  it('returns the live name after a content edit', () => {
    const runtime = new OperationRuntime();
    loadBase(runtime);
    applyContent(runtime, 'fresh text');

    expect(getRuntimeDisplayName(makePropNode(), runtime)).toBe(
      '[{"type":"paragraph","children":[{"type":"text","text":"fresh text"}]}]',
    );
  });
});

describe('readRuntimeName', () => {
  it('returns the fallback when the node is not projected', () => {
    const runtime = new OperationRuntime();
    expect(readRuntimeName(runtime, BLOCK_UUID, 'cached-name')).toBe('cached-name');
  });

  it('returns the live JSON name once projected', () => {
    const runtime = new OperationRuntime();
    loadBase(runtime);
    applyContent(runtime, 'projected');
    expect(readRuntimeName(runtime, BLOCK_UUID, 'cached-name')).toBe(
      '[{"type":"paragraph","children":[{"type":"text","text":"projected"}]}]',
    );
  });
});

describe('useRuntimeDisplayName', () => {
  it('returns the fallback, then updates live after a runtime content edit', () => {
    const runtime = new OperationRuntime();
    resetRuntimeEventBus(runtime);
    try {
      const fallback = '[{"type":"paragraph","children":[{"type":"text","text":"cached"}]}]';
      const { result } = renderHook(() => useRuntimeDisplayName(BLOCK_UUID, fallback, runtime));

      // Not projected yet → falls back to the query-cache name.
      expect(result.current).toBe(fallback);

      act(() => {
        loadBase(runtime);
        applyContent(runtime, 'live edit');
        getRuntimeEventBus(runtime).flushEvents();
      });

      expect(result.current).toBe(
        '[{"type":"paragraph","children":[{"type":"text","text":"live edit"}]}]',
      );
    } finally {
      // Restore the default event bus (wired to the global runtime) so other
      // test files are not affected by this test's runtime-scoped bus.
      resetRuntimeEventBus();
    }
  });
});
