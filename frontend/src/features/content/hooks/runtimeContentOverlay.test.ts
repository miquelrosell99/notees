/**
 * Tests for runtimeContentOverlay compatibility shim.
 *
 * The module now delegates to the core store for live subscriptions; the
 * non-hook helpers are pass-throughs because core-projected nodes are already
 * live.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '@/core/store';
import { uuidv7 } from '@/core/uuid';
import { createTestDatabase } from '@/core/__tests__/helpers';
import {
  overlayRuntimeContent,
  getRuntimeDisplayName,
  readRuntimeName,
  useRuntimeDisplayName,
} from './runtimeContentOverlay';
import type { Node } from '@/types/api';
import type { OperationRuntime } from '@/runtime';

vi.mock('react-router-dom', () => ({
  useParams: vi.fn(() => ({ workspaceId: 'ws-test' })),
}));

vi.mock('@/core/hooks', () => ({
  useWorkspaceStore: vi.fn(() => ({ store: undefined, isLoading: false })),
}));

const BLOCK_UUID = '22222222-2222-2222-2222-222222222222';

function makePropNode(overrides: Partial<Node> = {}): Node {
  return {
    uuid: BLOCK_UUID,
    name: '[{"type":"paragraph","children":[{"type":"text","text":"cached"}]}]',
    icon: null,
    color: null,
    parent_uuid: 'page-uuid',
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
  } as Node;
}

describe('overlayRuntimeContent', () => {
  it('returns the node unchanged (core nodes are already live)', () => {
    const node = makePropNode();
    expect(overlayRuntimeContent(null as unknown as OperationRuntime, node)).toBe(node);
  });
});

describe('getRuntimeDisplayName', () => {
  it('returns the node name directly', () => {
    const node = makePropNode();
    expect(getRuntimeDisplayName(node)).toBe(node.name);
  });
});

describe('readRuntimeName', () => {
  it('returns the fallback when no runtime projection exists', () => {
    expect(readRuntimeName(null, BLOCK_UUID, 'cached-name')).toBe('cached-name');
  });
});

describe('useRuntimeDisplayName', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  it('returns the fallback, then updates live after a core content edit', async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const store = new WorkspaceStore(db, workspaceId, actorId);

    store.createNode({ nodeId: BLOCK_UUID, kind: 'block', parentId: null });
    store.updateText(BLOCK_UUID, (text) => text.insert(0, 'cached'));

    const { useWorkspaceStore } = await import('@/core/hooks');
    vi.mocked(useWorkspaceStore).mockReturnValue({ store, isLoading: false, error: null });

    const fallback = '[{"type":"paragraph","children":[{"type":"text","text":"fallback"}]}]';
    const { result } = renderHook(() => useRuntimeDisplayName(BLOCK_UUID, fallback));

    // Core-projected nodes are already live, so the hook returns the derived name.
    expect(result.current).toBe('cached');

    act(() => {
      store.updateText(BLOCK_UUID, (text) => {
        const current = text.toPlaintext();
        text.delete(0, current.length);
        text.insert(0, 'live edit');
      });
    });

    expect(result.current).toBe('live edit');
  });
});
