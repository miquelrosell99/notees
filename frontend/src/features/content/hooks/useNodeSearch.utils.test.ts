/**
 * Tests for useNodeSearch utility result builders.
 */

import { describe, it, expect } from 'vitest';
import type { Node } from '@/types/api';
import { getAllResults, getPagesResults } from './useNodeSearch.utils';

function makeNode(overrides: Partial<Node> & { uuid: string }): Node {
  const {
    uuid,
    name = 'Node',
    parent_uuid = null,
    is_page = true,
    ...rest
  } = overrides;
  return {
    uuid,
    name,
    icon: null,
    color: null,
    parent_uuid,
    page_uuid: null,
    sequence: 0,
    active: true,
    is_page,
    create_date: new Date().toISOString(),
    write_date: new Date().toISOString(),
    ...rest,
  } as Node;
}

describe('getPagesResults', () => {
  it('returns pages for empty query', () => {
    const page = makeNode({ uuid: 'page-1', name: 'Regular page', is_page: true });

    const { pageResults } = getPagesResults(
      '',
      '',
      undefined,
      undefined,
      undefined,
      [page],
      [],
      undefined,
      undefined,
      10,
    );

    expect(pageResults.map(r => r.node.uuid)).toEqual(['page-1']);
  });

  it('returns pages from API search results', () => {
    const page = makeNode({ uuid: 'page-1', name: 'Regular page', is_page: true });

    const { pageResults } = getPagesResults(
      'Regular',
      'Regular',
      [page],
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      undefined,
      10,
    );

    expect(pageResults.map(r => r.node.uuid)).toEqual(['page-1']);
  });
});

describe('getAllResults', () => {
  it('returns pages and blocks for empty query', () => {
    const page = makeNode({ uuid: 'page-1', name: 'Regular page', is_page: true });
    const block = makeNode({ uuid: 'block-1', name: 'Block', is_page: false, parent_uuid: 'page-1' });

    const { pageResults, blockResults } = getAllResults(
      '',
      '',
      undefined,
      undefined,
      [page],
      [block],
      [],
      undefined,
      undefined,
      10,
    );

    expect(pageResults.map(r => r.node.uuid)).toEqual(['page-1']);
    expect(blockResults.map(r => r.node.uuid)).toEqual(['block-1']);
  });

  it('returns pages from API search results', () => {
    const page = makeNode({ uuid: 'page-1', name: 'Regular page', is_page: true });

    const { pageResults } = getAllResults(
      'Regular',
      'Regular',
      [page],
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      undefined,
      10,
    );

    expect(pageResults.map(r => r.node.uuid)).toEqual(['page-1']);
  });
});
