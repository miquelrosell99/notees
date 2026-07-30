import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../../store';
import { uuidv7 } from '../../uuid';
import { createTestDatabase } from '../../__tests__/helpers';
import { createOperation } from '../../types/operation';
import { applyOperation } from '../index';

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

async function createStore(): Promise<WorkspaceStore> {
  const db = await createTestDatabase();
  return new WorkspaceStore(db, uuidv7(), uuidv7());
}

function makeOp(
  opType: string,
  payload: Record<string, unknown>,
  overrides?: {
    workspaceId?: string;
    actorId?: string;
    hlc?: { physical: number; logical: number };
    affectedNodeIds?: string[];
  }
) {
  return createOperation(
    {
      workspaceId: overrides?.workspaceId ?? uuidv7(),
      actorId: overrides?.actorId ?? uuidv7(),
      hlc: overrides?.hlc ?? { physical: Date.now(), logical: 0 },
      affectedNodeIds: overrides?.affectedNodeIds ?? (payload.nodeId ? [payload.nodeId as string] : []),
      opType,
    },
    payload
  );
}

describe('applyOperation notifications', () => {
  it('returns node-scoped notifications for node.create', async () => {
    const store = await createStore();
    const nodeId = uuidv7();
    const op = makeOp('node.create', {
      nodeId,
      kind: 'page',
      parentId: null,
      classIds: [],
    });

    const notifications = applyOperation(store.getDb(), op);

    expect(notifications).toContainEqual({ scope: 'node', nodeId });
  });

  it('returns tree-scoped notifications for child order updates', async () => {
    const store = await createStore();
    const parentId = uuidv7();
    const childId = uuidv7();

    store.createNode({ nodeId: parentId, kind: 'page', parentId: null });
    store.createNode({ nodeId: childId, kind: 'block', parentId: null });

    const op = makeOp(
      'node.updateContent',
      { nodeId: parentId, treeUpdate: Array.from(store.getTreeState(parentId)) },
      { affectedNodeIds: [parentId] }
    );

    const notifications = applyOperation(store.getDb(), op);

    expect(notifications).toContainEqual(expect.objectContaining({ scope: 'tree', nodeId: parentId }));
  });

  it('returns property-scoped notifications for property.set', async () => {
    const store = await createStore();
    const nodeId = uuidv7();
    const schemaId = uuidv7();

    store.createNode({ nodeId, kind: 'page', parentId: null });

    const op = makeOp('property.set', {
      propertyValueId: uuidv7(),
      nodeId,
      schemaId,
      index: 0,
      value: 'hello',
    });

    const notifications = applyOperation(store.getDb(), op);

    expect(notifications).toContainEqual({ scope: 'property', nodeId, relatedIds: [schemaId] });
  });

  it('returns class-scoped notifications for class operations', async () => {
    const store = await createStore();
    const classId = uuidv7();

    const op = makeOp('class.create', { classId, name: 'Test Class' });

    const notifications = applyOperation(store.getDb(), op);

    expect(notifications).toContainEqual({ scope: 'class', nodeId: classId });
  });

  it('returns edge-scoped notifications via the store after content updates', async () => {
    const store = await createStore();
    const sourceId = uuidv7();
    const targetId = uuidv7();

    store.createNode({ nodeId: sourceId, kind: 'page', parentId: null });
    store.createNode({ nodeId: targetId, kind: 'page', parentId: null });
    store.updateContentAst(sourceId, [{ type: 'text', text: `See [[${targetId}]]` }]);

    const notifications: { scope?: string; nodeId?: string; relatedIds?: string[] }[] = [];
    store.subscribeAll((n) => {
      notifications.push({ scope: n?.scope, nodeId: n?.nodeId, relatedIds: n?.relatedIds });
    });

    store.updateContentAst(sourceId, [{ type: 'text', text: `See [[${targetId}]] and more` }]);

    expect(notifications.some((n) => n.scope === 'edge' && n.nodeId === sourceId)).toBe(true);
  });
});

describe('WorkspaceStore scoped notifications', () => {
  it('emits scoped notifications to node subscribers', async () => {
    const store = await createStore();
    const nodeId = uuidv7();
    store.createNode({ nodeId, kind: 'page', parentId: null });

    const received: { scope?: string; nodeId?: string }[] = [];
    store.subscribe(nodeId, (n) => {
      received.push({ scope: n?.scope, nodeId: n?.nodeId });
    });

    store.updateText(nodeId, (text) => text.insert(0, 'Hello'));

    expect(received).toContainEqual({ scope: 'node', nodeId });
  });

  it('emits notifications to global subscribers for every change', async () => {
    const store = await createStore();
    const nodeId = uuidv7();
    store.createNode({ nodeId, kind: 'page', parentId: null });

    const received: { scope?: string; nodeId?: string }[] = [];
    store.subscribeAll((n) => {
      received.push({ scope: n?.scope, nodeId: n?.nodeId });
    });

    store.updateText(nodeId, (text) => text.insert(0, 'Hello'));

    expect(received.length).toBeGreaterThan(0);
  });

  it('calls onNotify with scoped notifications when configured', async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const received: { scope?: string; nodeId?: string }[] = [];

    const store = new WorkspaceStore(db, workspaceId, actorId, {
      onNotify: (n) => {
        received.push({ scope: n.scope, nodeId: n.nodeId });
      },
    });

    const nodeId = uuidv7();
    store.createNode({ nodeId, kind: 'page', parentId: null });
    store.updateText(nodeId, (text) => text.insert(0, 'Hello'));

    expect(received.some((n) => n.scope === 'node' && n.nodeId === nodeId)).toBe(true);
  });
});
