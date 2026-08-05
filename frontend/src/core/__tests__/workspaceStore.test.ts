import { describe, it, expect, beforeAll, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../store';
import { uuidv7 } from '../uuid';
import { createTestDatabase } from './helpers';
import { getClass } from '../query/classes';

describe('WorkspaceStore', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  it('creates nodes', async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const store = new WorkspaceStore(db, workspaceId, actorId);

    const nodeId = uuidv7();
    store.createNode({ nodeId, kind: 'page', parentId: null });

    const node = store.getNode(nodeId);
    expect(node).toBeDefined();
    expect(node?.kind).toBe('page');
  });

  it('persists node icon and color on create and update', async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const store = new WorkspaceStore(db, workspaceId, actorId);

    const nodeId = uuidv7();
    store.createNode({
      nodeId,
      kind: 'page',
      parentId: null,
      icon: JSON.stringify({ icon: 'mdiStar', color: 'var(--color-preset-yellow)' }),
      color: '#ff0000',
    });

    const created = store.getNode(nodeId);
    expect(created?.icon).toBe(JSON.stringify({ icon: 'mdiStar', color: 'var(--color-preset-yellow)' }));
    expect(created?.color).toBe('#ff0000');

    store.updateNodeIcon(nodeId, JSON.stringify({ icon: 'mdiHeart' }));
    store.updateNodeColor(nodeId, '#00ff00');

    const updated = store.getNode(nodeId);
    expect(updated?.icon).toBe(JSON.stringify({ icon: 'mdiHeart' }));
    expect(updated?.color).toBe('#00ff00');

    store.updateNodeIcon(nodeId, null);
    store.updateNodeColor(nodeId, null);

    const cleared = store.getNode(nodeId);
    expect(cleared?.icon).toBeNull();
    expect(cleared?.color).toBeNull();
  });

  it('updates text content', async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const store = new WorkspaceStore(db, workspaceId, actorId);

    const nodeId = uuidv7();
    store.createNode({ nodeId, kind: 'page', parentId: null });
    store.updateText(nodeId, (text) => text.insert(0, 'Hello world'));

    const node = store.getNode(nodeId);
    expect(node).toBeDefined();
    const content = JSON.parse(node!.content);
    expect(content[0].text).toBe('Hello world');
  });

  it('sets node text', async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const store = new WorkspaceStore(db, workspaceId, actorId);

    const nodeId = uuidv7();
    store.createNode({ nodeId, kind: 'page', parentId: null });
    store.setNodeText(nodeId, 'Replaced content');

    const node = store.getNode(nodeId);
    expect(node).toBeDefined();
    const content = JSON.parse(node!.content);
    expect(content[0].text).toBe('Replaced content');
  });

  it('inserts and deletes node text', async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const store = new WorkspaceStore(db, workspaceId, actorId);

    const nodeId = uuidv7();
    store.createNode({ nodeId, kind: 'page', parentId: null });
    store.setNodeText(nodeId, 'Hello');
    store.insertNodeText(nodeId, 5, ' world');
    store.deleteNodeText(nodeId, 5, 6);

    const node = store.getNode(nodeId);
    expect(node).toBeDefined();
    const content = JSON.parse(node!.content);
    expect(content[0].text).toBe('Hello');
  });

  it('moves nodes between parents', async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const store = new WorkspaceStore(db, workspaceId, actorId);

    const parentId = uuidv7();
    const childId = uuidv7();
    store.createNode({ nodeId: parentId, kind: 'page', parentId: null });
    store.createNode({ nodeId: childId, kind: 'block', parentId: null });
    store.moveNode(childId, parentId);

    expect(store.getChildren(parentId)).toContain(childId);
  });

  it('sets and unsets properties', async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const store = new WorkspaceStore(db, workspaceId, actorId);

    const nodeId = uuidv7();
    const schemaId = uuidv7();
    const propertyValueId = uuidv7();
    store.createNode({ nodeId, kind: 'page', parentId: null });
    store.setProperty({ propertyValueId, nodeId, schemaId, value: 'done' });

    const row = store.getProperty({ nodeId, schemaId });
    expect(row).toBeDefined();
    expect(JSON.parse(row!.value)).toBe('done');

    store.unsetProperty({ nodeId, schemaId });
    expect(store.getProperty({ nodeId, schemaId })).toBeUndefined();
  });

  it('deletes nodes and their derived state', async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const store = new WorkspaceStore(db, workspaceId, actorId);

    const nodeId = uuidv7();
    store.createNode({ nodeId, kind: 'page', parentId: null });
    store.deleteNode(nodeId);

    expect(store.getNode(nodeId)).toBeUndefined();
  });

  it('calls onPersist after mutations', async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const onPersist = vi.fn();
    const store = new WorkspaceStore(db, workspaceId, actorId, {
      onPersist,
      persistDebounceMs: 10,
    });

    store.createNode({ nodeId: uuidv7(), kind: 'page', parentId: null });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onPersist).toHaveBeenCalled();
    expect(onPersist.mock.calls[0][0]).toBeInstanceOf(Uint8Array);
  });

  it('creates and restores snapshots', async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const store = new WorkspaceStore(db, workspaceId, actorId);

    const nodeId = uuidv7();
    store.createNode({ nodeId, kind: 'page', parentId: null });

    const snapshotHlc = store.getClock().advance(Date.now());
    const snapshotId = store.createSnapshot(snapshotHlc);
    expect(snapshotId).toBeDefined();

    // Mutate after snapshot.
    store.createNode({ nodeId: uuidv7(), kind: 'page', parentId: null });

    const restoredHlc = await store.restoreLatestSnapshot();
    expect(restoredHlc).toEqual(snapshotHlc);
    expect(store.getNode(nodeId)).toBeDefined();
  });

  it('compacts operations older than a given HLC', async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const store = new WorkspaceStore(db, workspaceId, actorId);

    const nodeId = uuidv7();
    store.createNode({ nodeId, kind: 'page', parentId: null });
    const opHlc = store.getClock().advance(Date.now());

    store.compactOperations(opHlc);

    const ops = db.exec(
      `SELECT id FROM operation WHERE workspace_id = '${workspaceId}'`
    );
    expect(ops.length).toBe(0);
  });

  it('creates a class via createClass', async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const store = new WorkspaceStore(db, workspaceId, actorId);

    const classId = uuidv7();
    store.createClass({ classId, name: 'Project', icon: 'folder', color: '#ff0000' });

    const row = getClass(db, classId);
    expect(row).toBeDefined();
    expect(row!.name).toBe('Project');
    expect(row!.icon).toBe('folder');
    expect(row!.color).toBe('#ff0000');
    expect(row!.active).toBe(true);
  });

  it('updates a class name', async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const store = new WorkspaceStore(db, workspaceId, actorId);

    const classId = uuidv7();
    store.createClass({ classId, name: 'Project' });
    store.updateClass({ classId, name: 'Area' });

    const row = getClass(db, classId);
    expect(row!.name).toBe('Area');
  });

  it('deletes a class', async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const store = new WorkspaceStore(db, workspaceId, actorId);

    const classId = uuidv7();
    store.createClass({ classId, name: 'Project' });
    store.deleteClass(classId);

    const row = getClass(db, classId);
    expect(row).toBeDefined();
    expect(row!.active).toBe(false);
  });

  it('sets class extends', async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const store = new WorkspaceStore(db, workspaceId, actorId);

    const parentId = uuidv7();
    const childId = uuidv7();
    store.createClass({ classId: parentId, name: 'Parent' });
    store.createClass({ classId: childId, name: 'Child' });
    store.setClassExtends({ classId: childId, extendsClassIds: [parentId] });

    const row = getClass(db, childId);
    expect(row!.extendsClassIds).toEqual([parentId]);
  });
});
