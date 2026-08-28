/**
 * Unit tests for the Library three-pane layout logic (Task 11):
 * collection tree building (nesting, hierarchy-aware class match, cycle
 * safety), expansion-aware flattening, pane selection transitions, and
 * collection contents resolution (multi-membership, dedupe) reused from
 * `collectionContents`.
 */
import { describe, it, expect } from 'vitest';

import type { Node } from '@/types';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { computeCollectionContents } from '@/features/content/utils/collectionContents';
import {
  ALL_SOURCES_SELECTION,
  buildCollectionTree,
  flattenCollectionTree,
  pruneSourceSelection,
  selectCollection,
  selectSource,
  toggleExpanded,
} from './collectionTree';

const COLLECTION = SYSTEM_CLASS_UUIDS.collection;
const SOURCE = SYSTEM_CLASS_UUIDS.source;

function makeNode(partial: Partial<Node> & { uuid: string; name?: string }): Node {
  return {
    name: partial.name ?? partial.uuid,
    icon: null,
    color: null,
    parent_uuid: null,
    page_uuid: null,
    sequence: 0,
    active: true,
    is_page: true,
    create_date: '',
    write_date: '',
    classes_uuid: [],
    properties_uuid: {},
    ...partial,
  } as Node;
}

function makeCollection(uuid: string, name: string, parentUuid: string | null = null): Node {
  return makeNode({ uuid, name, parent_uuid: parentUuid, classes_uuid: [COLLECTION] });
}

describe('buildCollectionTree', () => {
  it('nests subcollections beneath their parent collection, sorted by name', () => {
    const nodes = [
      makeCollection('fiction', 'Fiction'),
      makeCollection('scifi', 'Sci-Fi', 'fiction'),
      makeCollection('fantasy', 'Fantasy', 'fiction'),
      makeCollection('reading', 'Reading List'),
    ];

    const tree = buildCollectionTree(nodes, COLLECTION, []);

    expect(tree.map((n) => n.collection.uuid)).toEqual(['fiction', 'reading']);
    const fiction = tree[0];
    expect(fiction.children.map((n) => n.collection.uuid)).toEqual(['fantasy', 'scifi']);
    expect(tree[1].children).toEqual([]);
  });

  it('treats collections nested under non-collection pages as roots', () => {
    const page = makeNode({ uuid: 'page-1', name: 'Some page' });
    const nodes = [page, makeCollection('col', 'Collected', 'page-1')];
    const tree = buildCollectionTree(nodes, COLLECTION, []);
    expect(tree.map((n) => n.collection.uuid)).toEqual(['col']);
  });

  it('includes user subclasses of collection (hierarchy-aware)', () => {
    const watchlist = { uuid: 'cls-watchlist', extends_uuid: [COLLECTION] };
    const nodes = [
      makeNode({ uuid: 'w1', name: 'Watchlist', classes_uuid: ['cls-watchlist'] }),
      makeCollection('c1', 'Plain'),
    ];
    const tree = buildCollectionTree(nodes, COLLECTION, [watchlist]);
    expect(tree.map((n) => n.collection.uuid).sort()).toEqual(['c1', 'w1']);
  });

  it('excludes non-collection nodes', () => {
    const nodes = [
      makeCollection('col', 'Col'),
      makeNode({ uuid: 'src', name: 'Book', classes_uuid: [SOURCE], parent_uuid: 'col' }),
    ];
    const tree = buildCollectionTree(nodes, COLLECTION, []);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toEqual([]);
  });

  it('is cycle-safe: a parent cycle does not recurse forever', () => {
    const nodes = [
      makeCollection('a', 'A', 'b'),
      makeCollection('b', 'B', 'a'),
    ];
    // Both have a collection parent, so neither is a root — nothing renders.
    expect(buildCollectionTree(nodes, COLLECTION, [])).toEqual([]);

    // An unrelated root still renders; the cycle is simply unreachable.
    const withRoot = [...nodes, makeCollection('c', 'C')];
    const tree = buildCollectionTree(withRoot, COLLECTION, []);
    expect(tree.map((n) => n.collection.uuid)).toEqual(['c']);
  });
});

describe('flattenCollectionTree', () => {
  const tree = buildCollectionTree(
    [
      makeCollection('fiction', 'Fiction'),
      makeCollection('scifi', 'Sci-Fi', 'fiction'),
      makeCollection('reading', 'Reading'),
    ],
    COLLECTION,
    [],
  );

  it('lists roots only when nothing is expanded', () => {
    const rows = flattenCollectionTree(tree, new Set());
    expect(rows.map((r) => r.collection.uuid)).toEqual(['fiction', 'reading']);
    expect(rows[0]).toMatchObject({ depth: 0, hasChildren: true, expanded: false });
    expect(rows[1]).toMatchObject({ depth: 0, hasChildren: false });
  });

  it('reveals children of expanded nodes with increased depth', () => {
    const rows = flattenCollectionTree(tree, new Set(['fiction']));
    expect(rows.map((r) => [r.collection.uuid, r.depth])).toEqual([
      ['fiction', 0],
      ['scifi', 1],
      ['reading', 0],
    ]);
    expect(rows[0].expanded).toBe(true);
  });
});

describe('toggleExpanded', () => {
  it('adds and removes the uuid without mutating the input set', () => {
    const start = new Set(['a']);
    const opened = toggleExpanded(start, 'b');
    expect([...opened].sort()).toEqual(['a', 'b']);
    const closed = toggleExpanded(opened, 'a');
    expect([...closed]).toEqual(['b']);
    expect([...start]).toEqual(['a']);
  });
});

describe('pane selection', () => {
  it('starts at the All sources pseudo-root with no source selected', () => {
    expect(ALL_SOURCES_SELECTION).toEqual({ collectionUuid: null, sourceUuid: null });
  });

  it('selecting a collection drops the source selection', () => {
    const withSource = selectSource(ALL_SOURCES_SELECTION, 'src-1');
    const next = selectCollection(withSource, 'col-1');
    expect(next).toEqual({ collectionUuid: 'col-1', sourceUuid: null });
  });

  it('selecting All sources again drops the source selection', () => {
    const inCollection = selectSource(selectCollection(ALL_SOURCES_SELECTION, 'col-1'), 'src-1');
    expect(selectCollection(inCollection, null)).toEqual(ALL_SOURCES_SELECTION);
  });

  it('re-selecting the same collection keeps the state object (no render churn)', () => {
    const state = selectSource(selectCollection(ALL_SOURCES_SELECTION, 'col-1'), 'src-1');
    expect(selectCollection(state, 'col-1')).toBe(state);
    expect(selectSource(state, 'src-1')).toBe(state);
  });

  it('pruneSourceSelection clears a source that left the visible set', () => {
    const state = selectSource(ALL_SOURCES_SELECTION, 'src-1');
    expect(pruneSourceSelection(state, new Set(['src-1']))).toBe(state);
    expect(pruneSourceSelection(state, new Set(['src-2'])).sourceUuid).toBeNull();
  });
});

describe('collection contents resolution (Decision 22)', () => {
  it('dedupes a source that both nests under and links to the collection', () => {
    const both = makeNode({ uuid: 's-both', name: 'Both', classes_uuid: [SOURCE] });
    const nestedOnly = makeNode({ uuid: 's-nested', name: 'Nested', classes_uuid: [SOURCE] });
    const linkedOnly = makeNode({ uuid: 's-linked', name: 'Linked', classes_uuid: [SOURCE] });

    const contents = computeCollectionContents([both, nestedOnly], [both, linkedOnly]);

    expect(contents.map((n) => n.uuid)).toEqual(['s-both', 's-linked', 's-nested']);
  });

  it('multi-membership: one linked source appears in two collections as one object', () => {
    const shared = makeNode({ uuid: 's-shared', name: 'Shared', classes_uuid: [SOURCE] });
    const homeOnly = makeNode({ uuid: 's-home', name: 'Home', classes_uuid: [SOURCE] });

    const home = computeCollectionContents([shared, homeOnly], []);
    const other = computeCollectionContents([], [shared]);

    expect(home.map((n) => n.uuid).sort()).toEqual(['s-home', 's-shared']);
    expect(other.map((n) => n.uuid)).toEqual(['s-shared']);
    expect(home.find((n) => n.uuid === 's-shared')).toBe(other[0]);
  });
});
