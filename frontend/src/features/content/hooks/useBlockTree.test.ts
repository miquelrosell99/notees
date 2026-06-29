/**
 * Tests for useBlockTree projection helpers.
 */

import { describe, it, expect, vi } from 'vitest';
import { OperationRuntime } from '@/runtime';
import { flattenNodesFromRuntime, flattenNodes } from './useBlockTree';
import type { Operation } from '@/runtime';
import type { Node } from '@/types';

// The hook imports the sync barrel for collapse state; we only need the pure
// projection helpers here, so mock the barrel to avoid pulling in the search index.
vi.mock('@/features/sync', () => ({
  useUIStateStore: vi.fn(() => ({})),
}));

describe('flattenNodesFromRuntime', () => {
  it('shows a runtime-only top-level block even when the root page is not in the prop tree', () => {
    const runtime = new OperationRuntime();
    runtime.applyOperation({
      id: 'create-op',
      type: 'create',
      blockId: 'new-block',
      state: 'pending',
      dependsOn: [],
      retryCount: 0,
      maxRetries: 3,
      createdAt: Date.now(),
      payload: {
        parentId: 'page-uuid',
        afterBlockId: null,
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'new' }] }],
      },
    } as Operation);

    const flat = flattenNodesFromRuntime(
      [], // empty children list; page root is not passed in
      -1,
      false,
      false,
      runtime,
      () => undefined,
      false,
      false,
      true,
      'page-uuid',
      false,
    );

    const realNodes = flat.filter((n) => !n.isGhost);
    expect(realNodes).toHaveLength(1);
    expect(realNodes[0].node.uuid).toBe('new-block');
    expect(realNodes[0].depth).toBe(0);

    const ghosts = flat.filter((n) => n.isGhost);
    expect(ghosts.length).toBeGreaterThanOrEqual(1);
  });

  it('does not render a runtime-only block that has already been deleted', () => {
    const runtime = new OperationRuntime();
    runtime.applyOperation({
      id: 'create-op',
      type: 'create',
      blockId: 'new-block',
      state: 'pending',
      dependsOn: [],
      retryCount: 0,
      maxRetries: 3,
      createdAt: Date.now(),
      payload: {
        parentId: 'page-uuid',
        afterBlockId: null,
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'new' }] }],
      },
    } as Operation);
    runtime.applyOperation({
      id: 'delete-op',
      type: 'delete',
      blockId: 'new-block',
      state: 'pending',
      dependsOn: [],
      retryCount: 0,
      maxRetries: 3,
      createdAt: Date.now(),
      payload: {},
    } as Operation);

    const flat = flattenNodesFromRuntime(
      [],
      -1,
      false,
      false,
      runtime,
      () => undefined,
      false,
      false,
      true,
      'page-uuid',
      false,
    );

    expect(flat.some((n) => n.node.uuid === 'new-block')).toBe(false);
  });

  it('keeps runtime-only nested blocks under their real parent', () => {
    const runtime = new OperationRuntime();
    runtime.loadBaseNodes([
      {
        blockId: 'parent-uuid',
        parentId: 'page-uuid',
        orderIndex: 0,
        nodeType: 'block',
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'parent' }] }],
        collapsed: false,
        isDeleted: false,
        isPage: false,
        name: 'parent',
        icon: null,
        color: null,
        classIds: [],
        tagIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      },
    ]);
    runtime.applyOperation({
      id: 'create-op',
      type: 'create',
      blockId: 'new-child',
      state: 'pending',
      dependsOn: [],
      retryCount: 0,
      maxRetries: 3,
      createdAt: Date.now(),
      payload: {
        parentId: 'parent-uuid',
        afterBlockId: null,
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'child' }] }],
      },
    } as Operation);

    const flat = flattenNodesFromRuntime(
      [
        {
          uuid: 'parent-uuid',
          name: '[{"type":"paragraph","children":[{"type":"text","text":"parent"}]}]',
          icon: null,
          color: null,
          parent_uuid: 'page-uuid',
          page_uuid: null,
          sequence: 0,
          collapsed: false,
          active: true,
          is_page: false,
          is_deleted: false,
          has_children: true,
          children: [],
          create_date: new Date().toISOString(),
          write_date: new Date().toISOString(),
          classes_uuid: [],
          tags_uuid: [],
          properties_uuid: {},
        },
      ],
      -1,
      false,
      false,
      runtime,
      () => undefined,
      false,
      false,
      true,
      'page-uuid',
      false,
    );

    const child = flat.find((n) => n.node.uuid === 'new-child');
    expect(child).toBeDefined();
    expect(child!.depth).toBe(1);
  });

  it('renders each node once even when a UUID appears in multiple tree branches', () => {
    const runtime = new OperationRuntime();
    const shared: Node = {
      uuid: 'shared',
      name: 'Shared',
      icon: null,
      color: null,
      parent_uuid: 'root',
      page_uuid: null,
      sequence: 0,
      collapsed: false,
      active: true,
      is_page: false,
      is_deleted: false,
      has_children: false,
      children: [],
      create_date: new Date().toISOString(),
      write_date: new Date().toISOString(),
      classes_uuid: [],
      tags_uuid: [],
      properties_uuid: {},
    };

    const flat = flattenNodesFromRuntime(
      [
        {
          uuid: 'root1',
          name: 'Root 1',
          icon: null,
          color: null,
          parent_uuid: 'root',
          page_uuid: null,
          sequence: 0,
          collapsed: false,
          active: true,
          is_page: false,
          is_deleted: false,
          has_children: true,
          children: [shared],
          create_date: new Date().toISOString(),
          write_date: new Date().toISOString(),
          classes_uuid: [],
          tags_uuid: [],
          properties_uuid: {},
        },
        {
          uuid: 'root2',
          name: 'Root 2',
          icon: null,
          color: null,
          parent_uuid: 'root',
          page_uuid: null,
          sequence: 1,
          collapsed: false,
          active: true,
          is_page: false,
          is_deleted: false,
          has_children: true,
          children: [
            {
              uuid: 'middle',
              name: 'Middle',
              icon: null,
              color: null,
              parent_uuid: 'root2',
              page_uuid: null,
              sequence: 0,
              collapsed: false,
              active: true,
              is_page: false,
              is_deleted: false,
              has_children: true,
              // Inconsistent children: shared is also listed here, but its
              // parent_uuid points to root. The projection should still not
              // emit duplicate UUIDs.
              children: [shared],
              create_date: new Date().toISOString(),
              write_date: new Date().toISOString(),
              classes_uuid: [],
              tags_uuid: [],
              properties_uuid: {},
            },
          ],
          create_date: new Date().toISOString(),
          write_date: new Date().toISOString(),
          classes_uuid: [],
          tags_uuid: [],
          properties_uuid: {},
        },
      ],
      -1,
      false,
      false,
      runtime,
      () => undefined,
      false,
      false,
      true,
      'root',
      false,
    );

    const realUuids = flat.filter((n) => !n.isGhost).map((n) => n.node.uuid);
    expect(realUuids).toEqual([...new Set(realUuids)]);
    expect(realUuids.filter((id) => id === 'shared')).toHaveLength(1);
  });
});

describe('flattenNodes', () => {
  const makeNode = (uuid: string, children: Node[] = [], parentUuid: string | null = null): Node => ({
    uuid,
    name: uuid,
    icon: null,
    color: null,
    parent_uuid: parentUuid,
    page_uuid: null,
    sequence: 0,
    collapsed: false,
    active: true,
    is_page: false,
    is_deleted: false,
    has_children: children.length > 0,
    children,
    create_date: new Date().toISOString(),
    write_date: new Date().toISOString(),
    classes_uuid: [],
    tags_uuid: [],
    properties_uuid: {},
  });

  it('renders each node once when a UUID appears in multiple tree branches', () => {
    const shared = makeNode('shared');
    const tree = [
      makeNode('root1', [shared]),
      makeNode('root2', [makeNode('middle', [shared])]),
    ];

    const flat = flattenNodes(tree, -1, false, false, () => undefined);
    const uuids = flat.map((n) => n.node.uuid);
    expect(uuids.filter((id) => id === 'shared')).toHaveLength(1);
    expect(uuids).toEqual([...new Set(uuids)]);
  });
});
