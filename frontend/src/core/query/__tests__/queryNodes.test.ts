/**
 * Unit tests for queryNodes.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../../store';
import { uuidv7 } from '../../uuid';
import { createTestDatabase } from '../../__tests__/helpers';
import { queryNodes } from '../queryNodes';
import { createEmptyQueryAST, createClassCondition } from '@/types/queryAST';
import { createOperation, type Operation } from '../../types/operation';

describe('queryNodes', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  async function makeStore() {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    return new WorkspaceStore(db, workspaceId, actorId);
  }

  function applyClassCreate(store: WorkspaceStore, classId: string): void {
    const op: Operation = createOperation(
      {
        workspaceId: store.getWorkspaceId(),
        actorId: 'actor',
        hlc: { physical: Date.now(), logical: 0 },
        affectedNodeIds: [classId],
        opType: 'class.create',
      },
      { classId, name: 'Class', propertySchemaIds: [], extends: [] }
    );
    store.apply(op);
  }

  it('filters by text query', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'n1', kind: 'page', parentId: null });
    store.updateText('n1', (t) => t.insert(0, 'Hello world'));
    store.createNode({ nodeId: 'n2', kind: 'page', parentId: null });
    store.updateText('n2', (t) => t.insert(0, 'Goodbye moon'));

    const results = queryNodes(store, { query: 'world' });
    expect(results.map((n) => n.uuid)).toContain('n1');
    expect(results.map((n) => n.uuid)).not.toContain('n2');
  });

  it('filters by metadata flags', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: 'p1', kind: 'page', parentId: null });
    store.updateText('p1', (t) => t.insert(0, 'A page'));
    store.createNode({ nodeId: 'b1', kind: 'block', parentId: null });
    store.updateText('b1', (t) => t.insert(0, 'A block'));

    const pages = queryNodes(store, { query: 'A', isPage: true });
    expect(pages.map((n) => n.uuid)).toEqual(['p1']);
  });

  it('filters by class UUIDs', async () => {
    const store = await makeStore();
    applyClassCreate(store, 'class-1');
    store.createNode({ nodeId: 'n1', kind: 'page', parentId: null, classIds: ['class-1'] });
    store.updateText('n1', (t) => t.insert(0, 'Task A'));
    store.createNode({ nodeId: 'n2', kind: 'page', parentId: null });
    store.updateText('n2', (t) => t.insert(0, 'Task B'));

    const results = queryNodes(store, { query: 'Task', classIds: ['class-1'] });
    expect(results.map((n) => n.uuid)).toEqual(['n1']);
  });

  it('evaluates a QueryAST', async () => {
    const store = await makeStore();
    applyClassCreate(store, 'class-1');
    store.getDb().run('INSERT OR IGNORE INTO class_hierarchy (class_id, ancestor_id) VALUES (?, ?)', ['class-1', 'class-1']);

    store.createNode({ nodeId: 'n1', kind: 'page', parentId: null, classIds: ['class-1'] });
    store.createNode({ nodeId: 'n2', kind: 'page', parentId: null });

    const ast = {
      ...createEmptyQueryAST(),
      scope: { type: 'scope' as const, scope_type: 'pages' as const },
      root_group: {
        type: 'group' as const,
        logic: 'AND' as const,
        children: [createClassCondition('class-1')],
      },
    };

    const results = queryNodes(store, { ast });
    expect(results.map((n) => n.uuid)).toEqual(['n1']);
  });

  it('substitutes runtime params in QueryAST', async () => {
    const store = await makeStore();
    applyClassCreate(store, 'class-1');
    store.getDb().run('INSERT OR IGNORE INTO class_hierarchy (class_id, ancestor_id) VALUES (?, ?)', ['class-1', 'class-1']);

    store.createNode({ nodeId: 'n1', kind: 'page', parentId: null, classIds: ['class-1'] });

    const ast = {
      ...createEmptyQueryAST(),
      scope: { type: 'scope' as const, scope_type: 'pages' as const },
      root_group: {
        type: 'group' as const,
        logic: 'AND' as const,
        children: [createClassCondition('{current_node_uuid}')],
      },
    };

    const results = queryNodes(store, { ast, runtimeParams: { current_node_uuid: 'class-1' } });
    expect(results.map((n) => n.uuid)).toEqual(['n1']);
  });

  it('caps results at 500 nodes', async () => {
    const store = await makeStore();
    for (let i = 0; i < 550; i++) {
      store.createNode({ nodeId: `n-${i}`, kind: 'page', parentId: null });
      store.updateText(`n-${i}`, (t) => t.insert(0, 'Common term'));
    }

    const results = queryNodes(store, { query: 'Common' });
    expect(results).toHaveLength(500);
  });
});
