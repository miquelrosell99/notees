/**
 * Tests for useCoreBlockMutations.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import { renderHook, act } from '@testing-library/react';
import { WorkspaceStore } from '@/core/store';
import { UndoManager } from '@/core/undo/UndoManager';
import type { UndoManagerClient } from '@/core/hooks/useUndoManager';
import type { IWorkspaceStoreClient } from '@/core/worker/workerProtocol';
import { projectNode } from '@/core/adapters/nodeProjection';
import { uuidv7 } from '@/core/uuid';
import { createTestDatabase } from '@/core/__tests__/helpers';
import { useCoreBlockMutations } from './useCoreBlockMutations';

const mocks = vi.hoisted(() => ({
  store: undefined as WorkspaceStore | undefined,
  useWorkspaceStoreClient: vi.fn(() => ({ client: undefined as IWorkspaceStoreClient | undefined, isLoading: false, error: null })),
  useUndoManager: vi.fn(() => undefined as UndoManagerClient | undefined),
}));

vi.mock('react-router-dom', () => ({
  useParams: vi.fn(() => ({ workspaceId: 'ws-test' })),
}));

vi.mock('@/core/hooks', () => ({
  useWorkspaceStoreClient: mocks.useWorkspaceStoreClient,
  useUndoManager: mocks.useUndoManager,
  useNode: vi.fn(() => ({ node: undefined, isLoading: false, error: null })),
  useChildren: vi.fn(() => ({ children: [], isLoading: false, error: null })),
}));

async function createTestStore(): Promise<WorkspaceStore> {
  const db = await createTestDatabase();
  return new WorkspaceStore(db, uuidv7(), uuidv7());
}

function createTestWorkspaceStoreClient(store: WorkspaceStore): IWorkspaceStoreClient {
  return {
    init: async () => {},
    export: async () => store.export(),
    async mutate<T>(method: string, args: unknown[]): Promise<T> {
      const fn = (store as unknown as Record<string, unknown>)[method];
      if (typeof fn !== 'function') {
        throw new Error(`Unknown mutation method: ${method}`);
      }
      return fn.apply(store, args) as T;
    },
    async query<T>(method: string, args: unknown[]): Promise<T> {
      if (method === 'projectNode') {
        const [nodeId, depth] = args as [string, number | undefined];
        return projectNode(store, nodeId, depth) as T;
      }
      const fn = (store as unknown as Record<string, unknown>)[method];
      if (typeof fn !== 'function') {
        throw new Error(`Unknown query method: ${method}`);
      }
      return fn.apply(store, args) as T;
    },
    subscribe: () => () => {},
    close: () => {},
    isClosed: () => false,
  };
}

function createTestUndoManagerClient(store: WorkspaceStore): UndoManagerClient {
  const manager = UndoManager.getOrCreateUndoManager(store.getWorkspaceId(), store);
  return {
    createNode: async (args) => manager.createNode(args),
    createBlock: async (args) => manager.createBlock(args),
    deleteNode: async (nodeId) => manager.deleteNode(nodeId),
    moveNode: async (nodeId, newParentId) => manager.moveNode(nodeId, newParentId),
    mergeBlocks: async (sourceBlockId, targetBlockId) => manager.mergeBlocks(sourceBlockId, targetBlockId),
    setProperty: async (args) => manager.setProperty(args),
    unsetProperty: async (args) => manager.unsetProperty(args),
    assignClass: async (nodeId, classId) => manager.assignClass(nodeId, classId),
    unassignClass: async (nodeId, classId) => manager.unassignClass(nodeId, classId),
    recordSetNodeText: async (nodeId, value) => manager.recordSetNodeText(nodeId, value),
    undo: async () => manager.undo(),
    redo: async () => manager.redo(),
    canUndo: async () => manager.canUndo(),
    canRedo: async () => manager.canRedo(),
    clear: async () => manager.clear(),
    getStacks: async () => manager.getStacks(),
    subscribe: (listener) => manager.subscribe(listener),
  };
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
    mocks.useWorkspaceStoreClient.mockReturnValue({ client: createTestWorkspaceStoreClient(store), isLoading: false, error: null });
    mocks.useUndoManager.mockReturnValue(createTestUndoManagerClient(store));
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
