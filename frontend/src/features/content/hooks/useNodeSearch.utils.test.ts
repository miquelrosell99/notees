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
    is_class = false,
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
    is_class,
    create_date: new Date().toISOString(),
    write_date: new Date().toISOString(),
    ...rest,
  } as Node;
}

describe('getPagesResults', () => {
  it('excludes class nodes from page search results', () => {
    const page = makeNode({ uuid: 'page-1', name: 'Regular page', is_page: true });
    const classNode = makeNode({ uuid: 'class-1', name: 'Meeting', is_page: false, is_class: true });

    const { pageResults } = getPagesResults(
      '',
      '',
      undefined,
      undefined,
      undefined,
      [page, classNode],
      [],
      undefined,
      undefined,
      10,
    );

    expect(pageResults.map(r => r.node.uuid)).toEqual(['page-1']);
  });

  it('excludes class nodes from API search results', () => {
    const page = makeNode({ uuid: 'page-1', name: 'Regular page', is_page: true });
    const classNode = makeNode({ uuid: 'class-1', name: 'Meeting', is_page: false, is_class: true, parent_uuid: null });

    const { pageResults } = getPagesResults(
      'Meeting',
      'Meeting',
      [page, classNode],
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
  it('excludes class nodes from combined results', () => {
    const page = makeNode({ uuid: 'page-1', name: 'Regular page', is_page: true });
    const block = makeNode({ uuid: 'block-1', name: 'Block', is_page: false, parent_uuid: 'page-1' });
    const classNode = makeNode({ uuid: 'class-1', name: 'Meeting', is_page: false, is_class: true });

    const { pageResults, blockResults } = getAllResults(
      '',
      '',
      undefined,
      undefined,
      [page, classNode],
      [block],
      [],
      undefined,
      undefined,
      10,
    );

    expect(pageResults.map(r => r.node.uuid)).toEqual(['page-1']);
    expect(blockResults.map(r => r.node.uuid)).toEqual(['block-1']);
  });

  it('excludes class nodes from API search results', () => {
    const page = makeNode({ uuid: 'page-1', name: 'Regular page', is_page: true });
    const classNode = makeNode({ uuid: 'class-1', name: 'Meeting', is_page: false, is_class: true });

    const { pageResults } = getAllResults(
      'Meeting',
      'Meeting',
      [page, classNode],
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
