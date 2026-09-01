/**
 * Unit tests for countQueryResults — the COUNT path used by collapsed query
 * sections. The count must agree with what queryNodes returns when expanded.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../../store';
import { uuidv7 } from '../../uuid';
import { createTestDatabase } from '../../__tests__/helpers';
import { countQueryResults } from '../queryHelpers';
import { queryNodes } from '../../query/queryNodes';
import { createEmptyQueryAST, createClassCondition } from '@/types/queryAST';
import { createOperation, type Operation } from '../../types/operation';

describe('countQueryResults', () => {
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
    store.getDb().run('INSERT OR IGNORE INTO class_hierarchy (class_id, ancestor_id) VALUES (?, ?)', [classId, classId]);
  }

  function classQueryAST(classId: string) {
    return {
      ...createEmptyQueryAST(),
      scope: { type: 'scope' as const, scope_type: 'pages' as const },
      root_group: {
        type: 'group' as const,
        logic: 'AND' as const,
        children: [createClassCondition(classId)],
      },
    };
  }

  it('returns 0 without a query AST', async () => {
    const store = await makeStore();
    expect(countQueryResults(store, store.getWorkspaceId(), {})).toBe(0);
  });

  it('matches the filtered queryNodes result on a small fixture', async () => {
    const store = await makeStore();
    applyClassCreate(store, 'class-1');
    store.createNode({ nodeId: 'n1', kind: 'page', parentId: null, classIds: ['class-1'] });
    store.createNode({ nodeId: 'n2', kind: 'page', parentId: null, classIds: ['class-1'] });
    store.createNode({ nodeId: 'n3', kind: 'page', parentId: null });

    const ast = classQueryAST('class-1');
    const count = countQueryResults(store, store.getWorkspaceId(), { query_ast: ast });
    const results = queryNodes(store, { ast });

    expect(count).toBe(2);
    expect(count).toBe(results.length);
  });

  it('excludes archived nodes like the expanded query does', async () => {
    const store = await makeStore();
    applyClassCreate(store, 'class-1');
    store.createNode({ nodeId: 'n1', kind: 'page', parentId: null, classIds: ['class-1'] });
    store.createNode({ nodeId: 'n2', kind: 'page', parentId: null, classIds: ['class-1'] });
    store.archiveNode('n2');

    const ast = classQueryAST('class-1');
    const count = countQueryResults(store, store.getWorkspaceId(), { query_ast: ast });
    const results = queryNodes(store, { ast });

    expect(results.map((n) => n.uuid)).toEqual(['n1']);
    expect(count).toBe(results.length);
  });

  it('substitutes runtime params before counting', async () => {
    const store = await makeStore();
    applyClassCreate(store, 'class-1');
    store.createNode({ nodeId: 'n1', kind: 'page', parentId: null, classIds: ['class-1'] });

    const ast = classQueryAST('{current_node_uuid}');
    const count = countQueryResults(store, store.getWorkspaceId(), {
      query_ast: ast,
      runtime_params: { current_node_uuid: 'class-1' },
    });

    expect(count).toBe(1);
  });
});
