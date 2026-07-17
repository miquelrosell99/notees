import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { compileToSqlite } from '../compileToSqlite';
import { createTestDatabase } from '../../__tests__/helpers';
import { WorkspaceStore } from '../../store';
import { uuidv7 } from '../../uuid';
import { createOperation, type Operation } from '../../types/operation';
import type {
  QueryAST,
  ScopeNode,
  GroupNode,
  ClassCondition,
  ExtendsCondition,
  PropertyCondition,
  ContentCondition,
  StyleCondition,
  ReferenceCondition,
  ParentCondition,
  ChildPathCondition,
  PageCondition,
  AggregationNode,
} from '../../../types/queryAST';
import { queryAll } from '../../db/sqlite';

describe('compileToSqlite', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  async function makeStore() {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    return { db, workspaceId, actorId, store: new WorkspaceStore(db, workspaceId, actorId) };
  }

  function scope(type: ScopeNode['scope_type'], extras?: Partial<ScopeNode>): ScopeNode {
    return { type: 'scope', scope_type: type, ...extras };
  }

  function andGroup(children: GroupNode['children']): GroupNode {
    return { type: 'group', logic: 'AND', children };
  }

  function classCondition(classUuid: string): ClassCondition {
    return { type: 'condition', condition_type: 'class', class_uuid: classUuid };
  }

  function extendsCondition(classUuid: string): ExtendsCondition {
    return { type: 'condition', condition_type: 'extends', extends_class_uuid: classUuid };
  }

  function propertyCondition(
    name: string,
    operator: PropertyCondition['operator'],
    value: unknown,
    extras?: Partial<PropertyCondition>
  ): PropertyCondition {
    return {
      type: 'condition',
      condition_type: 'property',
      property_name: name,
      property_type: 'text',
      operator,
      value,
      ...extras,
    };
  }

  function contentCondition(value: string): ContentCondition {
    return {
      type: 'condition',
      condition_type: 'content',
      operator: 'contains',
      value,
    };
  }

  function styleCondition(styleType: StyleCondition['style_type']): StyleCondition {
    return {
      type: 'condition',
      condition_type: 'style',
      style_type: styleType,
      operator: 'contains',
    };
  }

  function referenceCondition(targetUuid: string): ReferenceCondition {
    return {
      type: 'condition',
      condition_type: 'reference',
      target_uuid: targetUuid,
    };
  }

  function parentCondition(parentUuid: string): ParentCondition {
    return {
      type: 'condition',
      condition_type: 'parent',
      parent_uuid: parentUuid,
    };
  }

  function childPathCondition(descendantUuid: string): ChildPathCondition {
    return {
      type: 'condition',
      condition_type: 'child_path',
      descendant_uuids: [descendantUuid],
    };
  }

  function pageCondition(pageUuid: string): PageCondition {
    return {
      type: 'condition',
      condition_type: 'page',
      page_uuid: pageUuid,
    };
  }

  function aggregation(dimField: string, measureField?: string): AggregationNode {
    return {
      type: 'aggregation',
      dimensions: [{ type: 'dimension', field: dimField }],
      measure: {
        type: 'measure',
        function: measureField ? 'sum' : 'count',
        ...(measureField ? { field: measureField, property_type: 'number' } : {}),
      },
    };
  }

  function query(scopeNode: ScopeNode, root?: GroupNode, agg?: AggregationNode): QueryAST {
    return {
      type: 'query',
      version: '1.0',
      scope: scopeNode,
      root_group: root ?? { type: 'group', logic: 'AND', children: [] },
      ...(agg ? { aggregation: agg } : {}),
    };
  }

  function execute(db: Awaited<ReturnType<typeof createTestDatabase>>, q: QueryAST, workspaceId: string) {
    const compiled = compileToSqlite(q, workspaceId);
    return queryAll<{ id: string }>(db, compiled.sql, compiled.params as never);
  }

  function applyClassCreate(
    store: WorkspaceStore,
    classId: string,
    name: string,
    extendsUuids: string[] = []
  ): void {
    const op: Operation = createOperation(
      {
        workspaceId: store.getWorkspaceId(),
        actorId: 'actor',
        hlc: { physical: Date.now(), logical: 0 },
        affectedNodeIds: [classId],
        opType: 'class.create',
      },
      { classId, name, propertySchemaIds: [], extends: extendsUuids }
    );
    store.apply(op);
  }

  function applyClassAssign(store: WorkspaceStore, nodeId: string, classId: string): void {
    const op: Operation = createOperation(
      {
        workspaceId: store.getWorkspaceId(),
        actorId: 'actor',
        hlc: { physical: Date.now(), logical: 0 },
        affectedNodeIds: [nodeId],
        opType: 'class.assign',
      },
      { nodeId, classId }
    );
    store.apply(op);
  }

  it('filters by scope pages', async () => {
    const { db, workspaceId, store } = await makeStore();
    store.createNode({ nodeId: 'page-1', kind: 'page', parentId: null });
    store.createNode({ nodeId: 'block-1', kind: 'block', parentId: null });

    const rows = execute(db, query(scope('pages')), workspaceId);
    expect(rows.map((r) => r.id)).toEqual(['page-1']);
  });

  it('filters by class and resolves inheritance', async () => {
    const { db, workspaceId, store } = await makeStore();
    applyClassCreate(store, 'class-a', 'A');
    applyClassCreate(store, 'class-b', 'B', ['class-a']);
    applyClassCreate(store, 'class-c', 'C', ['class-b']);

    store.createNode({ nodeId: 'node-a', kind: 'block', parentId: null });
    store.createNode({ nodeId: 'node-b', kind: 'block', parentId: null });
    store.createNode({ nodeId: 'node-c', kind: 'block', parentId: null });
    store.createNode({ nodeId: 'node-none', kind: 'block', parentId: null });

    applyClassAssign(store, 'node-a', 'class-a');
    applyClassAssign(store, 'node-b', 'class-b');
    applyClassAssign(store, 'node-c', 'class-c');

    const rowsA = execute(db, query(scope('entire_workspace'), andGroup([classCondition('class-a')])), workspaceId);
    expect([...rowsA.map((r) => r.id)].sort()).toEqual(['node-a', 'node-b', 'node-c']);

    const rowsB = execute(db, query(scope('entire_workspace'), andGroup([classCondition('class-b')])), workspaceId);
    expect([...rowsB.map((r) => r.id)].sort()).toEqual(['node-b', 'node-c']);

    const rowsC = execute(db, query(scope('entire_workspace'), andGroup([classCondition('class-c')])), workspaceId);
    expect([...rowsC.map((r) => r.id)].sort()).toEqual(['node-c']);
  });

  it('filters by extends condition', async () => {
    const { db, workspaceId, store } = await makeStore();
    applyClassCreate(store, 'class-a', 'A');
    applyClassCreate(store, 'class-b', 'B', ['class-a']);
    applyClassCreate(store, 'class-c', 'C', ['class-a']);

    const rows = execute(db, query(scope('entire_workspace'), andGroup([extendsCondition('class-a')])), workspaceId);
    expect([...rows.map((r) => r.id)].sort()).toEqual(['class-b', 'class-c']);
  });

  it('filters by builtin name property and content text', async () => {
    const { db, workspaceId, store } = await makeStore();
    store.createNode({ nodeId: 'page-1', kind: 'page', parentId: null });
    store.updateText('page-1', (text) => text.insert(0, 'Hello world'));
    store.createNode({ nodeId: 'page-2', kind: 'page', parentId: null });
    store.updateText('page-2', (text) => text.insert(0, 'Goodbye'));

    const q = query(scope('pages'), andGroup([propertyCondition('name', 'contains', 'Hello')]));
    const rows = execute(db, q, workspaceId);
    expect(rows.map((r) => r.id)).toEqual(['page-1']);

    const contentRows = execute(
      db,
      query(scope('pages'), andGroup([contentCondition('Goodbye')])),
      workspaceId
    );
    expect(contentRows.map((r) => r.id)).toEqual(['page-2']);
  });

  it('filters by style mark', async () => {
    const { db, workspaceId, store } = await makeStore();
    store.createNode({ nodeId: 'page-bold', kind: 'page', parentId: null });
    store.getDb().run(
      "UPDATE node SET content = ? WHERE id = ?",
      [JSON.stringify([{ type: 'paragraph', children: [{ type: 'text', text: 'Bold text', marks: [{ type: 'strong' }] }] }]), 'page-bold']
    );
    store.createNode({ nodeId: 'page-plain', kind: 'page', parentId: null });
    store.getDb().run(
      "UPDATE node SET content = ? WHERE id = ?",
      [JSON.stringify([{ type: 'paragraph', children: [{ type: 'text', text: 'Plain text' }] }]), 'page-plain']
    );

    const rows = execute(db, query(scope('pages'), andGroup([styleCondition('bold')])), workspaceId);
    expect(rows.map((r) => r.id)).toEqual(['page-bold']);
  });

  it('filters by reference condition', async () => {
    const { db, workspaceId, store } = await makeStore();
    const targetId = uuidv7();
    store.createNode({ nodeId: targetId, kind: 'page', parentId: null });
    store.createNode({ nodeId: 'referrer', kind: 'page', parentId: null });
    store.updateText('referrer', (text) => text.insert(0, `[[${targetId}]]`));
    store.createNode({ nodeId: 'non-referrer', kind: 'page', parentId: null });
    store.updateText('non-referrer', (text) => text.insert(0, 'No links here'));

    const rows = execute(db, query(scope('pages'), andGroup([referenceCondition(targetId)])), workspaceId);
    expect(rows.map((r) => r.id)).toEqual(['referrer']);
  });

  it('filters by parent and child_path conditions', async () => {
    const { db, workspaceId, store } = await makeStore();
    store.createNode({ nodeId: 'parent', kind: 'page', parentId: null });
    store.createNode({ nodeId: 'child', kind: 'block', parentId: 'parent' });
    store.createNode({ nodeId: 'grandchild', kind: 'block', parentId: 'child' });
    store.createNode({ nodeId: 'orphan', kind: 'block', parentId: null });

    const parentRows = execute(db, query(scope('entire_workspace'), andGroup([parentCondition('parent')])), workspaceId);
    expect([...parentRows.map((r) => r.id)].sort()).toEqual(['child']);

    const descendantRows = execute(
      db,
      query(scope('entire_workspace'), andGroup([childPathCondition('grandchild')])),
      workspaceId
    );
    expect([...descendantRows.map((r) => r.id)].sort()).toEqual(['child', 'parent']);
  });

  it('filters by page condition', async () => {
    const { db, workspaceId, store } = await makeStore();
    store.createNode({ nodeId: 'page-1', kind: 'page', parentId: null });
    store.createNode({ nodeId: 'block-1', kind: 'block', parentId: 'page-1' });
    store.createNode({ nodeId: 'page-2', kind: 'page', parentId: null });
    store.createNode({ nodeId: 'block-2', kind: 'block', parentId: 'page-2' });

    const rows = execute(db, query(scope('entire_workspace'), andGroup([pageCondition('page-1')])), workspaceId);
    expect([...rows.map((r) => r.id)].sort()).toEqual(['block-1', 'page-1']);
  });

  it('supports current_page scope', async () => {
    const { db, workspaceId, store } = await makeStore();
    store.createNode({ nodeId: 'page-1', kind: 'page', parentId: null });
    store.createNode({ nodeId: 'block-1', kind: 'block', parentId: 'page-1' });
    store.createNode({ nodeId: 'page-2', kind: 'page', parentId: null });
    store.createNode({ nodeId: 'block-2', kind: 'block', parentId: 'page-2' });

    const q = query(scope('current_page', { include_descendants: true }));
    const withoutCurrent = compileToSqlite(q, workspaceId);
    const rows = queryAll<{ id: string }>(db, withoutCurrent.sql, withoutCurrent.params as never);
    // currentNodeUuid is not provided, so the scope is ignored and all nodes are returned.
    expect([...rows.map((r) => r.id)].sort()).toEqual(['block-1', 'block-2', 'page-1', 'page-2']);

    const withCurrent = compileToSqlite(q, workspaceId, 'page-1');
    const scoped = queryAll<{ id: string }>(db, withCurrent.sql, withCurrent.params as never);
    expect([...scoped.map((r) => r.id)].sort()).toEqual(['block-1', 'page-1']);
  });

  it('aggregates count and numeric sums', async () => {
    const { db, workspaceId, store } = await makeStore();
    const schemaId = uuidv7();
    store.createNode({ nodeId: 'page-1', kind: 'page', parentId: null });
    store.createNode({ nodeId: 'page-2', kind: 'page', parentId: null });
    store.createNode({ nodeId: 'block-1', kind: 'block', parentId: 'page-1' });

    store.setProperty({ propertyValueId: uuidv7(), nodeId: 'page-1', schemaId, value: 10 });
    store.setProperty({ propertyValueId: uuidv7(), nodeId: 'page-2', schemaId, value: 20 });

    const countCompiled = compileToSqlite(query(scope('pages'), undefined, aggregation('is_page')), workspaceId);
    const countRows = queryAll<{ dim_0: unknown; value: unknown }>(db, countCompiled.sql, countCompiled.params as never);
    expect(countRows).toHaveLength(1);
    expect(countRows[0].dim_0).toBe(1);
    expect(countRows[0].value).toBe(2);

    const sumCompiled = compileToSqlite(
      query(scope('pages'), undefined, aggregation('is_page', schemaId)),
      workspaceId
    );
    const sumRows = queryAll<{ dim_0: unknown; value: unknown }>(db, sumCompiled.sql, sumCompiled.params as never);
    expect(sumRows).toHaveLength(1);
    expect(sumRows[0].dim_0).toBe(1);
    expect(sumRows[0].value).toBe(30);
  });
});
