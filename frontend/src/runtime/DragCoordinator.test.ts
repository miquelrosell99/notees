import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { getDragCoordinator } from '@/runtime/DragCoordinator';
import { getWorkspaceStore } from '@/core/adapters/workspaceStoreAdapter';
import type * as WorkspaceStoreAdapter from '@/core/adapters/workspaceStoreAdapter';
import { UndoManager } from '@/core/undo/UndoManager';
import { useUndoStore } from '@/stores';
import { WorkspaceStore } from '@/core/store';
import { uuidv7 } from '@/core/uuid';
import { createTestDatabase } from '@/core/__tests__/helpers';

vi.mock('@/core/adapters/workspaceStoreAdapter', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof WorkspaceStoreAdapter;
  return {
    ...actual,
    getWorkspaceStore: vi.fn(),
  };
});

async function createWorkspaceStore(): Promise<WorkspaceStore> {
  const db = await createTestDatabase();
  return new WorkspaceStore(db, uuidv7(), uuidv7());
}

describe('DragCoordinator', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    const coordinator = getDragCoordinator();
    coordinator.cancelDrag();
    coordinator.setMoveGuard(null);
  });

  afterEach(() => {
    useUndoStore.setState({ currentWorkspaceId: null });
  });

  it('moves a block to a new parent via UndoManager.moveNode', async () => {
    const store = await createWorkspaceStore();
    const workspaceId = store.getWorkspaceId();
    vi.mocked(getWorkspaceStore).mockReturnValue(store);
    UndoManager.getOrCreateUndoManager(workspaceId, store);
    useUndoStore.setState({ currentWorkspaceId: workspaceId });

    const rootId = uuidv7();
    const parentA = uuidv7();
    const parentB = uuidv7();
    const blockId = uuidv7();

    store.createNode({ nodeId: rootId, kind: 'page', parentId: null });
    store.createNode({ nodeId: parentA, kind: 'page', parentId: rootId });
    store.createNode({ nodeId: parentB, kind: 'page', parentId: rootId });
    store.createNode({ nodeId: blockId, kind: 'block', parentId: null });
    store.moveNode(blockId, parentA);

    expect(store.getNode(blockId)?.parentId).toBe(parentA);

    const coordinator = getDragCoordinator();
    coordinator.startDrag({
      blockId,
      sourceEditorId: 'editor-1',
      sourceDepth: 1,
    });
    coordinator.updateTarget({
      blockId: parentB,
      position: 'child',
      targetEditorId: 'editor-1',
    });
    await coordinator.completeDrag();

    expect(store.getNode(blockId)?.parentId).toBe(parentB);
    expect(store.getChildren(parentB)).toContain(blockId);
    expect(store.getChildren(parentA)).not.toContain(blockId);

    const manager = UndoManager.getUndoManager(workspaceId)!;
    expect(manager.canUndo()).toBe(true);

    manager.undo();
    expect(store.getNode(blockId)?.parentId).toBe(parentA);
  });

  it('cancels the drag when dropping onto a descendant', async () => {
    const store = await createWorkspaceStore();
    const workspaceId = store.getWorkspaceId();
    vi.mocked(getWorkspaceStore).mockReturnValue(store);
    UndoManager.getOrCreateUndoManager(workspaceId, store);
    useUndoStore.setState({ currentWorkspaceId: workspaceId });

    const rootId = uuidv7();
    const parentId = uuidv7();
    const childId = uuidv7();

    store.createNode({ nodeId: rootId, kind: 'page', parentId: null });
    store.createNode({ nodeId: parentId, kind: 'page', parentId: rootId });
    store.createNode({ nodeId: childId, kind: 'block', parentId: null });
    store.moveNode(childId, parentId);

    expect(store.getNode(childId)?.parentId).toBe(parentId);

    const coordinator = getDragCoordinator();
    coordinator.startDrag({
      blockId: parentId,
      sourceEditorId: 'editor-1',
      sourceDepth: 0,
    });
    coordinator.updateTarget({
      blockId: childId,
      position: 'child',
      targetEditorId: 'editor-1',
    });
    await coordinator.completeDrag();

    expect(store.getNode(childId)?.parentId).toBe(parentId);
    expect(store.getNode(parentId)?.parentId).toBe(rootId);

    const manager = UndoManager.getUndoManager(workspaceId)!;
    expect(manager.canUndo()).toBe(false);
    expect(coordinator.getState()).toEqual({ status: 'idle' });
  });

  it('preserves order when dragging multiple blocks', async () => {
    const store = await createWorkspaceStore();
    const workspaceId = store.getWorkspaceId();
    vi.mocked(getWorkspaceStore).mockReturnValue(store);
    UndoManager.getOrCreateUndoManager(workspaceId, store);
    useUndoStore.setState({ currentWorkspaceId: workspaceId });

    const rootId = uuidv7();
    const sourceParent = uuidv7();
    const targetParent = uuidv7();
    const blockA = uuidv7();
    const blockB = uuidv7();
    const blockC = uuidv7();

    store.createNode({ nodeId: rootId, kind: 'page', parentId: null });
    store.createNode({ nodeId: sourceParent, kind: 'page', parentId: rootId });
    store.createNode({ nodeId: targetParent, kind: 'page', parentId: rootId });

    for (const id of [blockA, blockB, blockC]) {
      store.createNode({ nodeId: id, kind: 'block', parentId: null });
      store.moveNode(id, sourceParent);
    }

    expect(store.getChildren(sourceParent)).toEqual([blockA, blockB, blockC]);

    const coordinator = getDragCoordinator();
    coordinator.startDrag({
      blockId: blockA,
      sourceEditorId: 'editor-1',
      sourceDepth: 1,
      blockIds: [blockA, blockC],
    });
    coordinator.updateTarget({
      blockId: targetParent,
      position: 'child',
      targetEditorId: 'editor-1',
    });
    await coordinator.completeDrag();

    expect(store.getChildren(targetParent)).toEqual([blockA, blockC]);
    expect(store.getChildren(sourceParent)).toEqual([blockB]);

    const manager = UndoManager.getUndoManager(workspaceId)!;
    expect(manager.canUndo()).toBe(true);

    manager.undo();
    manager.undo();
    const restoredChildren = store.getChildren(sourceParent);
    expect(restoredChildren).toContain(blockA);
    expect(restoredChildren).toContain(blockB);
    expect(restoredChildren).toContain(blockC);
  });
});
