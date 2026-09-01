/**
 * Tests for useContentSave.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import { renderHook, act, waitFor } from '@testing-library/react';
import { WorkspaceStore } from '@/core/store';
import { UndoManager } from '@/core/undo/UndoManager';
import type { UndoManagerClient } from '@/core/hooks/useUndoManager';
import type { IWorkspaceStoreClient } from '@/core/worker/workerProtocol';
import { projectNode } from '@/core/adapters/nodeProjection';
import { uuidv7 } from '@/core/uuid';
import { createTestDatabase } from '@/core/__tests__/helpers';
import { useContentSave } from '../useContentSave';

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
}));

async function createTestStore(): Promise<WorkspaceStore> {
  const db = await createTestDatabase();
  return new WorkspaceStore(db, uuidv7(), uuidv7());
}

function createTestWorkspaceStoreClient(store: WorkspaceStore): IWorkspaceStoreClient {
  return {
    init: async () => {},
    export: async () => store.export(),
    subscribeProgress: () => () => {},
    async mutate<T>(method: string, args: unknown[]): Promise<T> {
      const fn = (store as unknown as Record<string, unknown>)[method];
      if (typeof fn !== 'function') {
        throw new Error(`Unknown mutation method: ${method}`);
      }
      return fn.apply(store, args) as T;
    },
    async query<T>(method: string, args: unknown[], _signal?: AbortSignal): Promise<T> {
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

describe('useContentSave', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  beforeEach(async () => {
    const store = await createTestStore();
    mocks.store = store;
    mocks.useWorkspaceStoreClient.mockReturnValue({ client: undefined, isLoading: true, error: null });
    mocks.useUndoManager.mockReturnValue(undefined);
  });

  it('buffers edits while the workspace client is not ready and flushes once ready', async () => {
    const store = mocks.store!;
    const blockId = uuidv7();
    store.createNode({ nodeId: blockId, kind: 'block', parentId: null });

    const { result, rerender } = renderHook(() => useContentSave());

    // Emit an edit before the client/manager are available.
    await act(async () => {
      result.current.handleContentChange(blockId, 'Buffered content');
    });

    // The change has not been applied yet because the client is not ready.
    const textBeforeFlush = new TextDecoder().decode(store.getTextState(blockId));
    expect(textBeforeFlush).not.toContain('Buffered content');

    // Now make the client and manager available.
    const client = createTestWorkspaceStoreClient(store);
    const manager = createTestUndoManagerClient(store);
    mocks.useWorkspaceStoreClient.mockReturnValue({ client, isLoading: false, error: null });
    mocks.useUndoManager.mockReturnValue(manager);

    rerender();

    // Wait for the effect to flush the buffered change.
    await waitFor(() => {
      const textAfterFlush = new TextDecoder().decode(store.getTextState(blockId));
      expect(textAfterFlush).toContain('Buffered content');
    });
  });

  it('applies edits directly when the workspace client is already ready', async () => {
    const store = mocks.store!;
    const blockId = uuidv7();
    store.createNode({ nodeId: blockId, kind: 'block', parentId: null });

    const client = createTestWorkspaceStoreClient(store);
    const manager = createTestUndoManagerClient(store);
    mocks.useWorkspaceStoreClient.mockReturnValue({ client, isLoading: false, error: null });
    mocks.useUndoManager.mockReturnValue(manager);

    const { result } = renderHook(() => useContentSave());

    await act(async () => {
      result.current.handleContentChange(blockId, 'Direct content');
      await result.current.flushAll();
    });

    const text = new TextDecoder().decode(store.getTextState(blockId));
    expect(text).toContain('Direct content');
  });

  it('serializes saves per block so an older in-flight save cannot overwrite a newer one', async () => {
    const blockId = uuidv7();
    // A manager whose recordSetNodeText never resolves until the test says so,
    // simulating a slow worker round-trip.
    const calls: Array<{ value: string; resolve: () => void }> = [];
    const applied: string[] = [];
    const manager = {
      recordSetNodeText: vi.fn(
        (_nodeId: string, value: string) =>
          new Promise<void>((resolve) => {
            calls.push({
              value,
              resolve: () => {
                applied.push(value);
                resolve();
              },
            });
          })
      ),
    } as unknown as UndoManagerClient;
    const client = {
      query: vi.fn(async () => new Uint8Array()),
    } as unknown as IWorkspaceStoreClient;
    mocks.useWorkspaceStoreClient.mockReturnValue({ client, isLoading: false, error: null });
    mocks.useUndoManager.mockReturnValue(manager);

    const { result } = renderHook(() => useContentSave());

    // Issue two flushes in quick succession; the first save stays in flight.
    act(() => {
      result.current.handleContentChange(blockId, 'first');
      void result.current.flushAll();
      result.current.handleContentChange(blockId, 'second');
      void result.current.flushAll();
    });

    // Let any (incorrectly) concurrent saves start.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // The second save must wait for the first to complete; without
    // serialization both would be in flight and landing order would be
    // undefined (recordSetNodeText is a full-text SET, last writer wins).
    expect(calls).toHaveLength(1);
    expect(calls[0].value).toBe('first');

    await act(async () => {
      calls[0].resolve();
    });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].value).toBe('second');

    await act(async () => {
      calls[1].resolve();
    });
    expect(applied).toEqual(['first', 'second']);
  });
});
