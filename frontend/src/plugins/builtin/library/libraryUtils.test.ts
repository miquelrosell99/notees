/**
 * Unit tests for the Library plugin's pure view logic:
 * section filtering (hierarchy-aware, kind-agnostic), Work/Edition grouping,
 * cover resolution with parent fallback, and author name resolution.
 */
import { describe, it, expect } from 'vitest';

import type { Node } from '@/types';
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import {
  buildLibraryQueryAst,
  filterNodesBySection,
  groupSourcesIntoWorks,
  resolveAuthorNames,
  resolveCoverAssetUuid,
  readTextProperty,
} from './libraryUtils';

const SOURCE = SYSTEM_CLASS_UUIDS.source;
const BOOK = SYSTEM_CLASS_UUIDS.book;
const PAPER = SYSTEM_CLASS_UUIDS.paper;
const AGENT = SYSTEM_CLASS_UUIDS.agent;
const PERSON = SYSTEM_CLASS_UUIDS.person;
const COVER = SYSTEM_PROPERTY_UUIDS.cover;
const AUTHORS = SYSTEM_PROPERTY_UUIDS.authors;

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

describe('buildLibraryQueryAst', () => {
  it('builds a hierarchy-aware class query over the whole workspace', () => {
    const ast = buildLibraryQueryAst(SOURCE, 'sources');
    expect(ast.scope.scope_type).toBe('entire_workspace');
    expect(ast.root_group.logic).toBe('AND');
    const condition = ast.root_group.children[0];
    expect(condition).toMatchObject({
      type: 'condition',
      condition_type: 'class',
      operator: 'is_any_of',
      class_uuids: [SOURCE],
    });
  });
});

describe('filterNodesBySection', () => {
  const classes = [
    { uuid: BOOK, extends_uuid: [SOURCE] },
    { uuid: PAPER, extends_uuid: [SOURCE] },
  ];

  it('matches direct class membership and sorts by name', () => {
    const nodes = [
      makeNode({ uuid: 'b2', name: 'Zeta', classes_uuid: [BOOK] }),
      makeNode({ uuid: 'b1', name: 'Alpha', classes_uuid: [BOOK] }),
      makeNode({ uuid: 'p1', name: 'Beta', classes_uuid: [PAPER] }),
    ];
    const books = filterNodesBySection(nodes, BOOK, classes);
    expect(books.map((n) => n.uuid)).toEqual(['b1', 'b2']);
  });

  it('is kind-agnostic: block-classed books and page-classed books both list', () => {
    const nodes = [
      makeNode({ uuid: 'page-book', classes_uuid: [BOOK], is_page: true }),
      makeNode({ uuid: 'block-book', classes_uuid: [BOOK], is_page: false }),
    ];
    const books = filterNodesBySection(nodes, BOOK, classes);
    expect(books.map((n) => n.uuid).sort()).toEqual(['block-book', 'page-book']);
  });

  it('matches user subclasses of the section class (hierarchy-aware)', () => {
    const manga = { uuid: 'cls-manga', extends_uuid: [BOOK] };
    const nodes = [makeNode({ uuid: 'm1', classes_uuid: ['cls-manga'] })];
    const books = filterNodesBySection(nodes, BOOK, [...classes, manga]);
    expect(books.map((n) => n.uuid)).toEqual(['m1']);
  });

  it('matches system subclasses via static edges before class data loads', () => {
    // No live classes passed: static system extends edges still resolve.
    const nodes = [makeNode({ uuid: 'b1', classes_uuid: [BOOK] })];
    const sources = filterNodesBySection(nodes, SOURCE, []);
    expect(sources.map((n) => n.uuid)).toEqual(['b1']);
  });

  it('excludes nodes without the section class', () => {
    const nodes = [makeNode({ uuid: 'n1', classes_uuid: [] }), makeNode({ uuid: 'n2' })];
    expect(filterNodesBySection(nodes, BOOK, classes)).toEqual([]);
  });
});

describe('groupSourcesIntoWorks', () => {
  it('groups editions beneath their work; flat sources stay top-level', () => {
    const work = makeNode({ uuid: 'work', name: 'Dune', classes_uuid: [BOOK] });
    const editionA = makeNode({ uuid: 'ed-a', name: 'Dune (EPUB)', parent_uuid: 'work', classes_uuid: [BOOK] });
    const editionB = makeNode({ uuid: 'ed-b', name: 'Dune (PDF)', parent_uuid: 'work', classes_uuid: [BOOK] });
    const flat = makeNode({ uuid: 'flat', name: 'Flat Book', classes_uuid: [BOOK] });

    const groups = groupSourcesIntoWorks([editionB, flat, editionA, work]);

    expect(groups.map((g) => g.work.uuid)).toEqual(['work', 'flat']);
    const dune = groups[0];
    expect(dune.editions.map((e) => e.uuid)).toEqual(['ed-a', 'ed-b']);
    expect(groups[1].editions).toEqual([]);
  });

  it('promotes editions to top-level when the work is filtered out of the set', () => {
    const edition = makeNode({ uuid: 'ed', name: 'Edition', parent_uuid: 'missing-work' });
    const groups = groupSourcesIntoWorks([edition]);
    expect(groups).toHaveLength(1);
    expect(groups[0].work.uuid).toEqual('ed');
    expect(groups[0].editions).toEqual([]);
  });

  it('attaches editions to their direct parent only (one level)', () => {
    const work = makeNode({ uuid: 'w', name: 'W' });
    const edition = makeNode({ uuid: 'e', name: 'E', parent_uuid: 'w' });
    const subEdition = makeNode({ uuid: 'se', name: 'SE', parent_uuid: 'e' });
    const groups = groupSourcesIntoWorks([work, edition, subEdition]);
    expect(groups).toHaveLength(1);
    expect(groups[0].editions.map((e) => e.uuid)).toEqual(['e']);
  });
});

describe('resolveCoverAssetUuid', () => {
  it('returns the node cover when set', () => {
    const node = makeNode({ uuid: 'n', properties_uuid: { [COVER]: 'asset-own' } });
    expect(resolveCoverAssetUuid(node, new Map())).toBe('asset-own');
  });

  it('falls back to parent.cover (Work → Edition)', () => {
    const work = makeNode({ uuid: 'w', properties_uuid: { [COVER]: 'asset-parent' } });
    const edition = makeNode({ uuid: 'e', parent_uuid: 'w' });
    const byUuid = new Map([['w', work], ['e', edition]]);
    expect(resolveCoverAssetUuid(edition, byUuid)).toBe('asset-parent');
  });

  it('prefers the edition cover over the parent cover', () => {
    const work = makeNode({ uuid: 'w', properties_uuid: { [COVER]: 'asset-parent' } });
    const edition = makeNode({ uuid: 'e', parent_uuid: 'w', properties_uuid: { [COVER]: 'asset-own' } });
    const byUuid = new Map([['w', work], ['e', edition]]);
    expect(resolveCoverAssetUuid(edition, byUuid)).toBe('asset-own');
  });

  it('returns null when neither node nor parent has a cover (neutral placeholder)', () => {
    const work = makeNode({ uuid: 'w' });
    const edition = makeNode({ uuid: 'e', parent_uuid: 'w' });
    expect(resolveCoverAssetUuid(edition, new Map([['w', work]]))).toBeNull();
    expect(resolveCoverAssetUuid(makeNode({ uuid: 'orphan', parent_uuid: 'gone' }), new Map())).toBeNull();
  });

  it('ignores non-string cover values', () => {
    const node = makeNode({ uuid: 'n', properties_uuid: { [COVER]: 42 } });
    expect(resolveCoverAssetUuid(node, new Map())).toBeNull();
  });
});

describe('resolveAuthorNames', () => {
  const agents = new Map([
    ['a1', makeNode({ uuid: 'a1', name: 'Frank Herbert', classes_uuid: [PERSON] })],
    ['a2', makeNode({ uuid: 'a2', name: 'Penguin', classes_uuid: [AGENT] })],
  ]);

  it('resolves multi node-ref author values to names', () => {
    const node = makeNode({ uuid: 'n', properties_uuid: { [AUTHORS]: ['a1', 'a2'] } });
    expect(resolveAuthorNames(node, agents)).toEqual(['Frank Herbert', 'Penguin']);
  });

  it('skips unresolved author uuids and tolerates single-string values', () => {
    const node = makeNode({ uuid: 'n', properties_uuid: { [AUTHORS]: ['a1', 'missing'] } });
    expect(resolveAuthorNames(node, agents)).toEqual(['Frank Herbert']);
    const single = makeNode({ uuid: 'm', properties_uuid: { [AUTHORS]: 'a2' } });
    expect(resolveAuthorNames(single, agents)).toEqual(['Penguin']);
  });

  it('returns no names without an authors property', () => {
    expect(resolveAuthorNames(makeNode({ uuid: 'n' }), agents)).toEqual([]);
  });
});

describe('readTextProperty', () => {
  it('reads string values and falls back to empty string', () => {
    const node = makeNode({ uuid: 'n', properties_uuid: { [SYSTEM_PROPERTY_UUIDS.citekey]: 'herbert1965' } });
    expect(readTextProperty(node, SYSTEM_PROPERTY_UUIDS.citekey)).toBe('herbert1965');
    expect(readTextProperty(node, SYSTEM_PROPERTY_UUIDS.isbn)).toBe('');
  });
});
