/**
 * Tests for useCoreBlockMutations.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import { renderHook, act } from '@testing-library/react';
import { WorkspaceStore } from '@/core/store';
import { UndoManager } from '@/core/undo/UndoManager';
import { uuidv7 } from '@/core/uuid';
import { createTestDatabase } from '@/core/__tests__/helpers';
import { useCoreBlockMutations } from './useCoreBlockMutations';

const mocks = vi.hoisted(() => ({
  store: undefined as WorkspaceStore | undefined,
  useWorkspaceStore: vi.fn(() => ({ store: undefined as WorkspaceStore | undefined, isLoading: false, error: null })),
  useUndoManager: vi.fn(() => undefined as UndoManager | undefined),
}));

vi.mock('react-router-dom', () => ({
  useParams: vi.fn(() => ({ workspaceId: 'ws-test' })),
}));

vi.mock('@/core/hooks', () => ({
  useWorkspaceStore: mocks.useWorkspaceStore,
  useUndoManager: mocks.useUndoManager,
  useNode: vi.fn(() => ({ node: undefined, isLoading: false, error: null })),
  useChildren: vi.fn(() => ({ children: [], isLoading: false, error: null })),
}));

async function createTestStore(): Promise<WorkspaceStore> {
  const db = await createTestDatabase();
  return new WorkspaceStore(db, uuidv7(), uuidv7());
}

describe('useCoreBlockMutations', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  beforeEach(async () => {
    const store = await createTestStore();
    mocks.store = store;
    mocks.useWorkspaceStore.mockReturnValue({ store, isLoading: false, error: null });
    mocks.useUndoManager.mockReturnValue(UndoManager.getOrCreateUndoManager(store.getWorkspaceId(), store));
  });

  it('creates a block under a parent', async () => {
    const store = mocks.store!;
    const parentId = uuidv7();
    store.createNode({ nodeId: parentId, kind: 'page', parentId: null });

    const { result } = renderHook(() => useCoreBlockMutations('ws-test'));
    let newId = '';
    await act(async () => {
      newId = await result.current.createBlock({
        parentId,
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'hello' }] }],
      });
    });

    expect(store.getNode(newId)).toBeDefined();
    expect(store.getChildren(parentId)).toContain(newId);
  });

  it('moves a block to a new parent', async () => {
    const store = mocks.store!;
    const parentA = uuidv7();
    const parentB = uuidv7();
    const blockId = uuidv7();
    store.createNode({ nodeId: parentA, kind: 'page', parentId: null });
    store.createNode({ nodeId: parentB, kind: 'page', parentId: null });
    store.createNode({ nodeId: blockId, kind: 'block', parentId: null });
    store.moveNode(blockId, parentA);

    const { result } = renderHook(() => useCoreBlockMutations('ws-test'));
    await act(async () => {
      await result.current.moveBlock({ blockId, newParentId: parentB });
    });

    expect(store.getNode(blockId)?.parentId).toBe(parentB);
    expect(store.getChildren(parentB)).toContain(blockId);
  });

  it('deletes a block', async () => {
    const store = mocks.store!;
    const blockId = uuidv7();
    store.createNode({ nodeId: blockId, kind: 'block', parentId: null });

    const { result } = renderHook(() => useCoreBlockMutations('ws-test'));
    await act(async () => {
      await result.current.deleteBlock({ blockId });
    });

    expect(store.getNode(blockId)).toBeUndefined();
  });
});
