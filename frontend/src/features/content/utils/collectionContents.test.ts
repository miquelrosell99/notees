/**
 * Unit tests for collection contents semantics (Decision 22):
 * nested sources ∪ linked sources, deduped, plus the page-list exclusion.
 */
import { describe, it, expect } from 'vitest';

import type { Node } from '@/types';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import {
  buildCollectionLinkedQueryAst,
  buildCollectionNestedQueryAst,
  computeCollectionContents,
  filterOutCollectionPages,
} from './collectionContents';

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
    ...partial,
  } as Node;
}

describe('collection query ASTs', () => {
  it('nested query intersects class:source with has_ancestor(collection)', () => {
    const ast = buildCollectionNestedQueryAst('col-1', SOURCE);
    expect(ast.scope.scope_type).toBe('entire_workspace');
    expect(ast.root_group.logic).toBe('AND');
    expect(ast.root_group.children).toEqual([
      {
        type: 'condition',
        condition_type: 'class',
        operator: 'is_any_of',
        class_uuids: [SOURCE],
      },
      {
        type: 'condition',
        condition_type: 'parent_path',
        operator: 'has_ancestor',
        ancestor_uuids: ['col-1'],
      },
    ]);
  });

  it('linked query intersects class:source with references(collection)', () => {
    const ast = buildCollectionLinkedQueryAst('col-1', SOURCE);
    expect(ast.root_group.children).toEqual([
      {
        type: 'condition',
        condition_type: 'class',
        operator: 'is_any_of',
        class_uuids: [SOURCE],
      },
      {
        type: 'condition',
        condition_type: 'reference',
        operator: 'references',
        target_uuid: 'col-1',
      },
    ]);
  });
});

describe('computeCollectionContents', () => {
  it('unions nested and linked sources, deduped, sorted by name', () => {
    const nested = [
      makeNode({ uuid: 'n1', name: 'Beta' }),
      makeNode({ uuid: 'shared', name: 'Gamma' }),
    ];
    const linked = [
      makeNode({ uuid: 'l1', name: 'Alpha' }),
      makeNode({ uuid: 'shared', name: 'Gamma' }),
    ];
    const contents = computeCollectionContents(nested, linked);
    expect(contents.map((n) => n.uuid)).toEqual(['l1', 'n1', 'shared']);
  });

  it('handles empty inputs', () => {
    expect(computeCollectionContents([], [])).toEqual([]);
    const only = makeNode({ uuid: 'x' });
    expect(computeCollectionContents([only], []).map((n) => n.uuid)).toEqual(['x']);
  });
});

describe('filterOutCollectionPages', () => {
  it('drops collection-classed pages, keeps everything else', () => {
    const pages = [
      makeNode({ uuid: 'p1', name: 'Note' }),
      makeNode({ uuid: 'c1', name: 'My Collection', classes_uuid: [COLLECTION] }),
      makeNode({ uuid: 'p2', name: 'Book', classes_uuid: [SOURCE] }),
    ];
    const filtered = filterOutCollectionPages(pages, COLLECTION);
    expect(filtered.map((n) => n.uuid)).toEqual(['p1', 'p2']);
  });

  it('passes pages through when the collection class is unknown', () => {
    const pages = [makeNode({ uuid: 'p1' })];
    expect(filterOutCollectionPages(pages, null)).toBe(pages);
    expect(filterOutCollectionPages(pages, undefined)).toBe(pages);
  });
});
