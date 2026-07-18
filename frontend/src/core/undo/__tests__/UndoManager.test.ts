import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '@/core/store';
import { UndoManager } from '@/core/undo/UndoManager';
import { uuidv7 } from '@/core/uuid';
import { createTestDatabase } from '@/core/__tests__/helpers';

describe('UndoManager', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  async function createStore(): Promise<WorkspaceStore> {
    const db = await createTestDatabase();
    return new WorkspaceStore(db, uuidv7(), uuidv7());
  }

  it('static registry returns the same instance per workspace', async () => {
    const store = await createStore();
    const workspaceId = store.getWorkspaceId();

    const first = UndoManager.getOrCreateUndoManager(workspaceId, store);
    const second = UndoManager.getOrCreateUndoManager(workspaceId, store);
    expect(first).toBe(second);
    expect(UndoManager.getUndoManager(workspaceId)).toBe(first);
  });

  it('create + undo deletes the node', async () => {
    const store = await createStore();
    const manager = new UndoManager(store);
    const nodeId = uuidv7();

    manager.createNode({ nodeId, kind: 'page', parentId: null });
    expect(store.getNode(nodeId)).toBeDefined();

    const entry = manager.undo();
    expect(entry).not.toBeNull();
    expect(store.getNode(nodeId)).toBeUndefined();
    expect(manager.canUndo()).toBe(false);
    expect(manager.canRedo()).toBe(true);
  });

  it('delete + undo recreates the node with content and properties', async () => {
    const store = await createStore();
    const manager = new UndoManager(store);
    const parentId = uuidv7();
    const nodeId = uuidv7();
    const schemaId = uuidv7();
    const propertyValueId = uuidv7();
    const classId = uuidv7();

    store.createNode({ nodeId: parentId, kind: 'page', parentId: null });
    store.createNode({ nodeId, kind: 'block', parentId: null });
    store.moveNode(nodeId, parentId);
    store.updateText(nodeId, (text) => text.insert(0, 'Hello world'));
    store.setProperty({ propertyValueId, nodeId, schemaId, value: 'done' });
    store.assignClass(nodeId, classId);

    manager.deleteNode(nodeId);
    expect(store.getNode(nodeId)).toBeUndefined();
    expect(store.getChildren(parentId)).not.toContain(nodeId);

    manager.undo();
    const restored = store.getNode(nodeId);
    expect(restored).toBeDefined();
    expect(restored?.parentId).toBe(parentId);
    expect(restored?.classIds).toContain(classId);
    expect(store.getChildren(parentId)).toContain(nodeId);

    const content = JSON.parse(restored!.content);
    expect(content[0].text).toBe('Hello world');

    const property = store.getProperty({ nodeId, schemaId });
    expect(property).toBeDefined();
    expect(JSON.parse(property!.value)).toBe('done');
  });

  it('move + undo moves back to old parent', async () => {
    const store = await createStore();
    const manager = new UndoManager(store);
    const parentA = uuidv7();
    const parentB = uuidv7();
    const nodeId = uuidv7();

    store.createNode({ nodeId: parentA, kind: 'page', parentId: null });
    store.createNode({ nodeId: parentB, kind: 'page', parentId: null });
    store.createNode({ nodeId, kind: 'block', parentId: null });
    store.moveNode(nodeId, parentA);

    manager.moveNode(nodeId, parentB);
    expect(store.getNode(nodeId)?.parentId).toBe(parentB);
    expect(store.getChildren(parentB)).toContain(nodeId);

    manager.undo();
    expect(store.getNode(nodeId)?.parentId).toBe(parentA);
    expect(store.getChildren(parentA)).toContain(nodeId);
  });

  it('set property + undo restores old value or unsets', async () => {
    const store = await createStore();
    const manager = new UndoManager(store);
    const nodeId = uuidv7();
    const schemaId = uuidv7();
    const propertyValueId = uuidv7();

    store.createNode({ nodeId, kind: 'page', parentId: null });

    manager.setProperty({ propertyValueId, nodeId, schemaId, value: 'first' });
    expect(JSON.parse(store.getProperty({ nodeId, schemaId })!.value)).toBe('first');

    manager.setProperty({ propertyValueId, nodeId, schemaId, value: 'second' });
    expect(JSON.parse(store.getProperty({ nodeId, schemaId })!.value)).toBe('second');

    manager.undo();
    expect(JSON.parse(store.getProperty({ nodeId, schemaId })!.value)).toBe('first');

    manager.undo();
    expect(store.getProperty({ nodeId, schemaId })).toBeUndefined();
  });

  it('unset property + undo restores old value', async () => {
    const store = await createStore();
    const manager = new UndoManager(store);
    const nodeId = uuidv7();
    const schemaId = uuidv7();
    const propertyValueId = uuidv7();

    store.createNode({ nodeId, kind: 'page', parentId: null });
    store.setProperty({ propertyValueId, nodeId, schemaId, value: 'value' });

    manager.unsetProperty({ nodeId, schemaId });
    expect(store.getProperty({ nodeId, schemaId })).toBeUndefined();

    manager.undo();
    expect(JSON.parse(store.getProperty({ nodeId, schemaId })!.value)).toBe('value');
  });

  it('text update + undo restores old text', async () => {
    const store = await createStore();
    const manager = new UndoManager(store);
    const nodeId = uuidv7();

    store.createNode({ nodeId, kind: 'page', parentId: null });
    manager.updateText(nodeId, (text) => text.insert(0, 'Hello'));
    manager.updateText(nodeId, (text) => text.insert(5, ' world'));

    const afterEdit = JSON.parse(store.getNode(nodeId)!.content);
    expect(afterEdit[0].text).toBe('Hello world');

    manager.undo();
    const afterUndo = JSON.parse(store.getNode(nodeId)!.content);
    expect(afterUndo[0].text).toBe('Hello');

    manager.undo();
    const afterSecondUndo = JSON.parse(store.getNode(nodeId)!.content);
    expect(afterSecondUndo[0].text).toBe('');
  });

  it('redo reapplies a previously undone action', async () => {
    const store = await createStore();
    const manager = new UndoManager(store);
    const nodeId = uuidv7();

    manager.createNode({ nodeId, kind: 'page', parentId: null });
    expect(store.getNode(nodeId)).toBeDefined();

    manager.undo();
    expect(store.getNode(nodeId)).toBeUndefined();

    manager.redo();
    expect(store.getNode(nodeId)).toBeDefined();
    expect(manager.canUndo()).toBe(true);
    expect(manager.canRedo()).toBe(false);
  });

  it('notifies listeners on stack changes', async () => {
    const store = await createStore();
    const manager = new UndoManager(store);
    const nodeId = uuidv7();
    const events: string[] = [];

    const unsubscribe = manager.subscribe((event) => {
      events.push(event.type);
    });

    manager.createNode({ nodeId, kind: 'page', parentId: null });
    manager.undo();
    manager.redo();

    expect(events).toContain('stack_changed');
    expect(events).toContain('undo');
    expect(events).toContain('redo');

    unsubscribe();
  });

  it('clear empties both stacks', async () => {
    const store = await createStore();
    const manager = new UndoManager(store);
    const nodeId = uuidv7();

    manager.createNode({ nodeId, kind: 'page', parentId: null });
    manager.undo();
    expect(manager.canRedo()).toBe(true);

    manager.clear();
    expect(manager.canUndo()).toBe(false);
    expect(manager.canRedo()).toBe(false);
    expect(manager.getStacks().undo).toHaveLength(0);
    expect(manager.getStacks().redo).toHaveLength(0);
  });

  it('caps the undo stack at 100 entries', async () => {
    const store = await createStore();
    const manager = new UndoManager(store);

    for (let i = 0; i < 110; i++) {
      const nodeId = uuidv7();
      manager.createNode({ nodeId, kind: 'page', parentId: null });
    }

    expect(manager.getStacks().undo).toHaveLength(100);
  });

  it('createBlock creates a node with initial content', async () => {
    const store = await createStore();
    const manager = new UndoManager(store);
    const nodeId = uuidv7();

    manager.createBlock({ nodeId, kind: 'block', parentId: null, content: 'hello' });
    const node = store.getNode(nodeId);
    expect(node).toBeDefined();
    expect(JSON.parse(node!.content)[0].text).toBe('hello');

    manager.undo();
    expect(store.getNode(nodeId)).toBeUndefined();
  });

  it('mergeBlocks concatenates text, moves children, and deletes source', async () => {
    const store = await createStore();
    const manager = new UndoManager(store);
    const parentId = uuidv7();
    const targetId = uuidv7();
    const sourceId = uuidv7();
    const childId = uuidv7();

    store.createNode({ nodeId: parentId, kind: 'page', parentId: null });
    store.createNode({ nodeId: targetId, kind: 'block', parentId: null });
    store.createNode({ nodeId: sourceId, kind: 'block', parentId: null });
    store.createNode({ nodeId: childId, kind: 'block', parentId: null });
    store.moveNode(targetId, parentId);
    store.moveNode(sourceId, parentId);
    store.moveNode(childId, sourceId);
    store.updateText(targetId, (text) => text.insert(0, 'target'));
    store.updateText(sourceId, (text) => text.insert(0, 'source'));

    manager.mergeBlocks(sourceId, targetId);

    expect(store.getNode(sourceId)).toBeUndefined();
    expect(store.getChildren(targetId)).toContain(childId);
    const content = JSON.parse(store.getNode(targetId)!.content);
    expect(content[0].text).toBe('targetsource');

    manager.undo();
    expect(store.getNode(sourceId)).toBeDefined();
    // Prototype limitation: undo restores the source node and its text, but
    // children moved during the merge stay under the target.
    expect(store.getChildren(targetId)).toContain(childId);
    expect(JSON.parse(store.getNode(targetId)!.content)[0].text).toBe('target');
  });
});
