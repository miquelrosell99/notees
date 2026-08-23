import { describe, it, expect } from 'vitest';
import type { Database } from 'sql.js';
import { createOperation, type Operation } from '../../types/operation';
import { applyClassOperation } from '../class';
import { WorkspaceStore } from '../../store';
import { createTestDatabase } from '../../__tests__/helpers';
import { queryAll } from '../../db/sqlite';

let hlcCounter = 0;

function makeOp(opType: string, payload: Record<string, unknown>): Operation {
  hlcCounter += 1;
  return createOperation(
    {
      workspaceId: 'ws-1',
      actorId: 'actor-1',
      hlc: { physical: hlcCounter, logical: 0 },
      affectedNodeIds: payload.classId ? [payload.classId as string] : [],
      opType,
    },
    payload
  );
}

function closure(db: Database, classId: string): string[] {
  return queryAll<{ ancestor_id: string }>(
    db,
    'SELECT ancestor_id FROM class_hierarchy WHERE class_id = ? ORDER BY ancestor_id',
    [classId]
  ).map((row) => row.ancestor_id);
}

function applyAll(db: Database, ops: Operation[]): void {
  for (const op of ops) applyClassOperation(db, op);
}

/** ``X <- source <- book``; then source is reparented from X to Y. */
function reparentingOps(): Operation[] {
  return [
    makeOp('class.create', { classId: 'x', name: 'X' }),
    makeOp('class.create', { classId: 'y', name: 'Y' }),
    makeOp('class.create', { classId: 'source', name: 'source' }),
    makeOp('class.create', { classId: 'book', name: 'book' }),
    makeOp('class.setExtends', { classId: 'source', extendsClassIds: ['x'] }),
    makeOp('class.setExtends', { classId: 'book', extendsClassIds: ['source'] }),
    makeOp('class.setExtends', { classId: 'source', extendsClassIds: ['y'] }),
  ];
}

describe('class hierarchy recursive closure recompute', () => {
  it('reparenting a class updates descendant closures', async () => {
    const db = await createTestDatabase();
    applyAll(db, reparentingOps());

    expect(closure(db, 'source')).toEqual(['source', 'y']);
    expect(closure(db, 'book')).toEqual(['book', 'source', 'y']);
  });

  it('recompute cascades through multiple levels', async () => {
    const db = await createTestDatabase();
    applyAll(db, [
      makeOp('class.create', { classId: 'x', name: 'X' }),
      makeOp('class.create', { classId: 'y', name: 'Y' }),
      makeOp('class.create', { classId: 'source', name: 'source' }),
      makeOp('class.create', { classId: 'book', name: 'book' }),
      makeOp('class.create', { classId: 'chapter', name: 'chapter' }),
      makeOp('class.setExtends', { classId: 'source', extendsClassIds: ['x'] }),
      makeOp('class.setExtends', { classId: 'book', extendsClassIds: ['source'] }),
      makeOp('class.setExtends', { classId: 'chapter', extendsClassIds: ['book'] }),
      makeOp('class.setExtends', { classId: 'source', extendsClassIds: ['y'] }),
    ]);

    expect(closure(db, 'chapter')).toEqual(['book', 'chapter', 'source', 'y']);
  });

  it('class.create with extends builds the closure', async () => {
    const db = await createTestDatabase();
    applyAll(db, [
      makeOp('class.create', { classId: 'x', name: 'X' }),
      makeOp('class.create', { classId: 'source', name: 'source', extends: ['x'] }),
    ]);

    expect(closure(db, 'source')).toEqual(['source', 'x']);
  });

  it('class.update with extends recomputes the closure and its descendants', async () => {
    const db = await createTestDatabase();
    applyAll(db, [
      makeOp('class.create', { classId: 'x', name: 'X' }),
      makeOp('class.create', { classId: 'y', name: 'Y' }),
      makeOp('class.create', { classId: 'source', name: 'source' }),
      makeOp('class.create', { classId: 'book', name: 'book' }),
      makeOp('class.setExtends', { classId: 'source', extendsClassIds: ['x'] }),
      makeOp('class.setExtends', { classId: 'book', extendsClassIds: ['source'] }),
      makeOp('class.update', { classId: 'source', name: 'source', extends: ['y'] }),
    ]);

    expect(closure(db, 'source')).toEqual(['source', 'y']);
    expect(closure(db, 'book')).toEqual(['book', 'source', 'y']);
  });

  it('class.update without extends keeps the closure', async () => {
    const db = await createTestDatabase();
    applyAll(db, [
      makeOp('class.create', { classId: 'x', name: 'X' }),
      makeOp('class.create', { classId: 'source', name: 'source', extends: ['x'] }),
      makeOp('class.update', { classId: 'source', name: 'renamed' }),
    ]);

    expect(closure(db, 'source')).toEqual(['source', 'x']);
  });

  it('replay is deterministic', async () => {
    const first = await createTestDatabase();
    const second = await createTestDatabase();
    applyAll(first, reparentingOps());
    applyAll(second, reparentingOps());

    const query = 'SELECT class_id, ancestor_id FROM class_hierarchy ORDER BY class_id, ancestor_id';
    expect(queryAll(first, query)).toEqual(queryAll(second, query));
  });
});

describe('class hierarchy cycle-safe replay', () => {
  it('a historical cycle does not crash or hang the applier', async () => {
    const db = await createTestDatabase();
    applyAll(db, [
      makeOp('class.create', { classId: 'a', name: 'A' }),
      makeOp('class.create', { classId: 'b', name: 'B' }),
      makeOp('class.setExtends', { classId: 'a', extendsClassIds: ['b'] }),
      makeOp('class.setExtends', { classId: 'b', extendsClassIds: ['a'] }),
    ]);

    expect(closure(db, 'a')).toEqual(['a', 'b']);
    expect(closure(db, 'b')).toEqual(['a', 'b']);
  });
});

describe('WorkspaceStore class extends cycle rejection', () => {
  async function createStore() {
    const db = await createTestDatabase();
    const store = new WorkspaceStore(db, 'ws-1', 'actor-1');
    return { db, store };
  }

  it('rejects a direct cycle', async () => {
    const { store } = await createStore();
    store.createClass({ classId: 'a', name: 'A' });
    store.createClass({ classId: 'b', name: 'B' });
    store.setClassExtends({ classId: 'a', extendsClassIds: ['b'] });

    expect(() => store.setClassExtends({ classId: 'b', extendsClassIds: ['a'] })).toThrow(
      /inheritance cycle/
    );
  });

  it('rejects a self-loop', async () => {
    const { store } = await createStore();
    store.createClass({ classId: 'a', name: 'A' });

    expect(() => store.setClassExtends({ classId: 'a', extendsClassIds: ['a'] })).toThrow(
      /inheritance cycle/
    );
  });

  it('rejects an indirect cycle', async () => {
    const { store } = await createStore();
    for (const classId of ['a', 'b', 'c']) {
      store.createClass({ classId, name: classId.toUpperCase() });
    }
    store.setClassExtends({ classId: 'a', extendsClassIds: ['b'] });
    store.setClassExtends({ classId: 'b', extendsClassIds: ['c'] });

    expect(() => store.setClassExtends({ classId: 'c', extendsClassIds: ['a'] })).toThrow(
      /inheritance cycle/
    );
  });

  it('accepts a valid extends chain', async () => {
    const { db, store } = await createStore();
    store.createClass({ classId: 'x', name: 'X' });
    store.createClass({ classId: 'source', name: 'source' });
    store.createClass({ classId: 'book', name: 'book' });
    store.setClassExtends({ classId: 'source', extendsClassIds: ['x'] });
    store.setClassExtends({ classId: 'book', extendsClassIds: ['source'] });

    expect(closure(db, 'book')).toEqual(['book', 'source', 'x']);
  });

  it('emits no operation for a rejected cycle', async () => {
    const { db, store } = await createStore();
    store.createClass({ classId: 'a', name: 'A' });
    store.createClass({ classId: 'b', name: 'B' });
    store.setClassExtends({ classId: 'a', extendsClassIds: ['b'] });

    expect(() => store.setClassExtends({ classId: 'b', extendsClassIds: ['a'] })).toThrow(
      /inheritance cycle/
    );
    expect(closure(db, 'b')).toEqual(['b']);
  });
});
