/**
 * Tests for useBlockTree projection helpers.
 */

import { describe, it, expect, vi } from 'vitest';
import { OperationRuntime } from '@/runtime';
import { flattenNodesFromRuntime } from './useBlockTree';
import type { Operation } from '@/runtime';

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
});
