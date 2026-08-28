/**
 * Tests for the generic hierarchy-aware class filter helpers (Decision 9):
 * filter UUIDs expand through the class hierarchy so superclass filters match
 * subclass instances, without over-broadening exact-subclass filters.
 */
import { describe, it, expect } from 'vitest';
import { createOperation, type Operation } from '../../types/operation';
import { applyClassOperation } from '../../derived/class';
import { WorkspaceStore } from '../../store';
import { createTestDatabase } from '../../__tests__/helpers';
import {
  expandClassFilterUuids,
  expandClassFilterUuidsFromDb,
  nodeMatchesExpandedClassFilter,
} from '../classFilter';
import { buildSuggestions } from '../../worker/queryHelpers';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { uuidv7 } from '../../uuid';

let hlcCounter = 0;

function makeOp(opType: string, payload: Record<string, unknown>, workspaceId = 'ws-1'): Operation {
  hlcCounter += 1;
  return createOperation(
    {
      workspaceId,
      actorId: 'actor-1',
      hlc: { physical: hlcCounter, logical: 0 },
      affectedNodeIds: payload.classId ? [payload.classId as string] : [],
      opType,
    },
    payload
  );
}

describe('expandClassFilterUuids (client-side)', () => {
  it('returns empty for no filters', () => {
    expect(expandClassFilterUuids([], [])).toEqual([]);
  });

  it('expands a superclass filter to all descendants via live class data', () => {
    const classes = [
      { uuid: 'book', extends_uuid: ['source'] },
      { uuid: 'paper', extends_uuid: ['source'] },
      { uuid: 'chapter', extends_uuid: ['book'] },
      { uuid: 'task', extends_uuid: [] },
    ];
    const expanded = expandClassFilterUuids(['source'], classes);
    expect(expanded.sort()).toEqual(['book', 'chapter', 'paper', 'source']);
  });

  it('resolves system subclasses from the static extends map when the class list is empty', () => {
    const expanded = expandClassFilterUuids([SYSTEM_CLASS_UUIDS.agent], []);
    expect(expanded.sort()).toEqual(
      [SYSTEM_CLASS_UUIDS.agent, SYSTEM_CLASS_UUIDS.person, SYSTEM_CLASS_UUIDS.organization].sort()
    );
  });

  it('does not over-broaden an exact-subclass filter', () => {
    const expanded = expandClassFilterUuids([SYSTEM_CLASS_UUIDS.book], []);
    expect(expanded).toEqual([SYSTEM_CLASS_UUIDS.book]);
    expect(expanded).not.toContain(SYSTEM_CLASS_UUIDS.paper);
    expect(expanded).not.toContain(SYSTEM_CLASS_UUIDS.source);
  });

  it('expands user-defined subclasses of system classes', () => {
    const classes = [{ uuid: 'my-novel-class', extends_uuid: [SYSTEM_CLASS_UUIDS.book] }];
    const expanded = expandClassFilterUuids([SYSTEM_CLASS_UUIDS.source], classes);
    expect(expanded).toContain('my-novel-class');
    expect(expanded).toContain(SYSTEM_CLASS_UUIDS.movie);
  });

  it('passes unknown filter UUIDs through unchanged', () => {
    expect(expandClassFilterUuids(['nope'], [])).toEqual(['nope']);
  });
});

describe('expandClassFilterUuidsFromDb (closure table)', () => {
  it('resolves descendants through class_hierarchy', async () => {
    const db = await createTestDatabase();
    applyClassOperation(db, makeOp('class.create', { classId: 'source', name: 'source' }));
    applyClassOperation(db, makeOp('class.create', { classId: 'book', name: 'book', extends: ['source'] }));
    applyClassOperation(db, makeOp('class.create', { classId: 'chapter', name: 'chapter', extends: ['book'] }));

    const expanded = expandClassFilterUuidsFromDb(db, ['source']);
    expect([...expanded].sort()).toEqual(['book', 'chapter', 'source']);

    // No over-broadening: book only matches itself + its subclasses.
    const bookOnly = expandClassFilterUuidsFromDb(db, ['book']);
    expect([...bookOnly].sort()).toEqual(['book', 'chapter']);
  });

  it('expansion is idempotent for already-expanded sets', async () => {
    const db = await createTestDatabase();
    applyClassOperation(db, makeOp('class.create', { classId: 'source', name: 'source' }));
    applyClassOperation(db, makeOp('class.create', { classId: 'book', name: 'book', extends: ['source'] }));

    const once = expandClassFilterUuidsFromDb(db, ['source']);
    const twice = expandClassFilterUuidsFromDb(db, [...once]);
    expect([...twice].sort()).toEqual([...once].sort());
  });
});

describe('nodeMatchesExpandedClassFilter', () => {
  it('matches direct membership in the expanded set', () => {
    const expanded = new Set(['a', 'b']);
    expect(nodeMatchesExpandedClassFilter(['b'], expanded)).toBe(true);
    expect(nodeMatchesExpandedClassFilter(['c'], expanded)).toBe(false);
    expect(nodeMatchesExpandedClassFilter([], expanded)).toBe(false);
    expect(nodeMatchesExpandedClassFilter(undefined, expanded)).toBe(false);
  });
});

describe('buildSuggestions class filtering (worker-side)', () => {
  async function createStoreWithClasses() {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const store = new WorkspaceStore(db, workspaceId, uuidv7());
    store.applyMany([
      makeOp('class.create', { classId: 'source', name: 'source' }, workspaceId),
      makeOp('class.create', { classId: 'book', name: 'book', extends: ['source'] }, workspaceId),
      makeOp('class.create', { classId: 'paper', name: 'paper', extends: ['source'] }, workspaceId),
    ]);
    return { db, store, workspaceId };
  }

  it('a superclass suggestion filter offers subclass instances', async () => {
    const { store } = await createStoreWithClasses();
    const bookNodeId = uuidv7();
    store.createNode({ nodeId: bookNodeId, kind: 'page', parentId: null, classIds: ['book'] });

    const suggestions = buildSuggestions(store, 'source');
    expect(suggestions.map((n) => n.uuid)).toContain(bookNodeId);
  });

  it('an exact-subclass filter does not match sibling subclasses', async () => {
    const { store } = await createStoreWithClasses();
    const bookNodeId = uuidv7();
    const paperNodeId = uuidv7();
    store.createNode({ nodeId: bookNodeId, kind: 'page', parentId: null, classIds: ['book'] });
    store.createNode({ nodeId: paperNodeId, kind: 'page', parentId: null, classIds: ['paper'] });

    const bookSuggestions = buildSuggestions(store, 'book');
    expect(bookSuggestions.map((n) => n.uuid)).toContain(bookNodeId);
    expect(bookSuggestions.map((n) => n.uuid)).not.toContain(paperNodeId);

    // Unclassed nodes never match a class filter.
    const plainId = uuidv7();
    store.createNode({ nodeId: plainId, kind: 'page', parentId: null });
    expect(buildSuggestions(store, 'source').map((n) => n.uuid)).not.toContain(plainId);
  });
});
