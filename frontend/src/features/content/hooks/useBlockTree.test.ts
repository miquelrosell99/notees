/**
 * Tests for useBlockTree projection helpers.
 */

import { describe, it, expect, vi } from 'vitest';
import { OperationRuntime } from '@/runtime';
import { flattenNodesFromRuntime, flattenNodes } from './useBlockTree';
import { applyIntent } from '@/sync/intents';
import type { Operation } from '@/runtime';
import type { Node } from '@/types';

// The hook imports the sync barrel for collapse state; we only need the pure
// projection helpers here, so mock the barrel to avoid pulling in the search index.
vi.mock('@/features/sync', () => ({
  useUIStateStore: vi.fn(() => ({})),
}));

// Realistic UUIDs so ghost-block validation (which rejects non-UUID / pseudo IDs) passes.
const PAGE_UUID = '11111111-1111-1111-1111-111111111111';
const PARENT_UUID = '22222222-2222-2222-2222-222222222222';
const NEW_BLOCK_UUID = '33333333-3333-3333-3333-333333333333';
const NEW_CHILD_UUID = '44444444-4444-4444-4444-444444444444';
const ROOT_UUID = '55555555-5555-5555-5555-555555555555';
const ROOT1_UUID = '66666666-6666-6666-6666-666666666666';
const ROOT2_UUID = '77777777-7777-7777-7777-777777777777';
const SHARED_UUID = '88888888-8888-8888-8888-888888888888';
const MIDDLE_UUID = '99999999-9999-9999-9999-999999999999';
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

describe('flattenNodesFromRuntime', () => {
  it('shows a runtime-only top-level block even when the root page is not in the prop tree', () => {
    const runtime = new OperationRuntime();
    runtime.applyOperation({
      id: 'create-op',
      type: 'create',
      blockId: NEW_BLOCK_UUID,
      state: 'pending',
      dependsOn: [],
      retryCount: 0,
      maxRetries: 3,
      createdAt: Date.now(),
      payload: {
        parentId: PAGE_UUID,
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
      PAGE_UUID,
      false,
    );

    const realNodes = flat.filter((n) => !n.isGhost);
    expect(realNodes).toHaveLength(1);
    expect(realNodes[0].node.uuid).toBe(NEW_BLOCK_UUID);
    expect(realNodes[0].depth).toBe(0);

    const ghosts = flat.filter((n) => n.isGhost);
    expect(ghosts.length).toBeGreaterThanOrEqual(1);
  });

  it('does not render a runtime-only block that has already been deleted', () => {
    const runtime = new OperationRuntime();
    runtime.applyOperation({
      id: 'create-op',
      type: 'create',
      blockId: NEW_BLOCK_UUID,
      state: 'pending',
      dependsOn: [],
      retryCount: 0,
      maxRetries: 3,
      createdAt: Date.now(),
      payload: {
        parentId: PAGE_UUID,
        afterBlockId: null,
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'new' }] }],
      },
    } as Operation);
    runtime.applyOperation({
      id: 'delete-op',
      type: 'delete',
      blockId: NEW_BLOCK_UUID,
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
      PAGE_UUID,
      false,
    );

    expect(flat.some((n) => n.node.uuid === NEW_BLOCK_UUID)).toBe(false);
  });

  it('does not render a prop node that has been deleted in the runtime', () => {
    const runtime = new OperationRuntime();
    runtime.loadBaseNodes([
      {
        blockId: PARENT_UUID,
        parentId: PAGE_UUID,
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
      id: 'delete-op',
      type: 'delete',
      blockId: PARENT_UUID,
      state: 'pending',
      dependsOn: [],
      retryCount: 0,
      maxRetries: 3,
      createdAt: Date.now(),
      payload: {},
    } as Operation);

    const flat = flattenNodesFromRuntime(
      [
        {
          uuid: PARENT_UUID,
          name: '[{"type":"paragraph","children":[{"type":"text","text":"parent"}]}]',
          icon: null,
          color: null,
          parent_uuid: PAGE_UUID,
          page_uuid: null,
          sequence: 0,
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
      PAGE_UUID,
      false,
    );

    expect(flat.some((n) => n.node.uuid === PARENT_UUID)).toBe(false);
  });

  it('keeps runtime-only nested blocks under their real parent', () => {
    const runtime = new OperationRuntime();
    runtime.loadBaseNodes([
      {
        blockId: PARENT_UUID,
        parentId: PAGE_UUID,
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
      blockId: NEW_CHILD_UUID,
      state: 'pending',
      dependsOn: [],
      retryCount: 0,
      maxRetries: 3,
      createdAt: Date.now(),
      payload: {
        parentId: PARENT_UUID,
        afterBlockId: null,
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'child' }] }],
      },
    } as Operation);

    const flat = flattenNodesFromRuntime(
      [
        {
          uuid: PARENT_UUID,
          name: '[{"type":"paragraph","children":[{"type":"text","text":"parent"}]}]',
          icon: null,
          color: null,
          parent_uuid: PAGE_UUID,
          page_uuid: null,
          sequence: 0,
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
      PAGE_UUID,
      false,
    );

    const child = flat.find((n) => n.node.uuid === NEW_CHILD_UUID);
    expect(child).toBeDefined();
    expect(child!.depth).toBe(1);
  });

  it('renders each node once even when a UUID appears in multiple tree branches', () => {
    const runtime = new OperationRuntime();
    const shared: Node = {
      uuid: SHARED_UUID,
      name: 'Shared',
      icon: null,
      color: null,
      parent_uuid: ROOT_UUID,
      page_uuid: null,
      sequence: 0,
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
          uuid: ROOT1_UUID,
          name: 'Root 1',
          icon: null,
          color: null,
          parent_uuid: ROOT_UUID,
          page_uuid: null,
          sequence: 0,
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
          uuid: ROOT2_UUID,
          name: 'Root 2',
          icon: null,
          color: null,
          parent_uuid: ROOT_UUID,
          page_uuid: null,
          sequence: 1,
          active: true,
          is_page: false,
          is_deleted: false,
          has_children: true,
          children: [
            {
              uuid: MIDDLE_UUID,
              name: 'Middle',
              icon: null,
              color: null,
              parent_uuid: ROOT2_UUID,
              page_uuid: null,
              sequence: 0,
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
      ROOT_UUID,
      false,
    );

    const realUuids = flat.filter((n) => !n.isGhost).map((n) => n.node.uuid);
    expect(realUuids).toEqual([...new Set(realUuids)]);
    expect(realUuids.filter((id) => id === SHARED_UUID)).toHaveLength(1);
  });

  it('does not emit a root ghost for the zero/pseudo UUID', () => {
    const runtime = new OperationRuntime();
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
      ZERO_UUID,
      false,
    );
    expect(flat.some((n) => n.isGhost)).toBe(false);
  });

  it('does not emit a root ghost for a virtual root ID', () => {
    const runtime = new OperationRuntime();
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
      'vroot-abc-def-2',
      false,
    );
    expect(flat.some((n) => n.isGhost)).toBe(false);
  });

  it('does not emit nested ghosts for nodes with invalid UUIDs', () => {
    const runtime = new OperationRuntime();
    const flat = flattenNodesFromRuntime(
      [
        {
          uuid: 'not-a-uuid',
          name: 'Bad node',
          icon: null,
          color: null,
          parent_uuid: PAGE_UUID,
          page_uuid: null,
          sequence: 0,
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
      PAGE_UUID,
      false,
    );
    const ghosts = flat.filter((n) => n.isGhost);
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].node.uuid).toBe(`__ghost-${PAGE_UUID}`);
  });

  it('reflects runtime content updates for runtime-only nodes', () => {
    const runtime = new OperationRuntime();
    runtime.applyOperation({
      id: 'create-op',
      type: 'create',
      blockId: NEW_BLOCK_UUID,
      state: 'pending',
      dependsOn: [],
      retryCount: 0,
      maxRetries: 3,
      createdAt: Date.now(),
      payload: {
        parentId: PAGE_UUID,
        afterBlockId: null,
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
      },
    } as Operation);

    runtime.applyOperation({
      id: 'update-op',
      type: 'update_content',
      blockId: NEW_BLOCK_UUID,
      state: 'pending',
      dependsOn: [],
      retryCount: 0,
      maxRetries: 3,
      createdAt: Date.now(),
      payload: {
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'typed content' }] }],
      },
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
      PAGE_UUID,
      false,
    );

    const node = flat.find((n) => n.node.uuid === NEW_BLOCK_UUID);
    expect(node).toBeDefined();
    expect(node!.node.name).toBe('[{"type":"paragraph","children":[{"type":"text","text":"typed content"}]}]');
  });

  it('reflects runtime content updates for an existing prop node after edit (blur)', () => {
    // Regression: editing an existing persisted block and then exiting edit mode
    // (clicking outside) left the read-only static view showing the stale
    // query-cache content until a full reload. The runtime projection had the
    // new content, but flattenNodesFromRuntime only overlaid runtime contentAST
    // for runtime-only nodes, not for nodes already present in the prop tree.
    const runtime = new OperationRuntime();
    runtime.loadBaseNodes([
      {
        blockId: PARENT_UUID,
        parentId: PAGE_UUID,
        orderIndex: 0,
        nodeType: 'block',
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
        collapsed: false,
        isDeleted: false,
        isPage: false,
        name: '',
        icon: null,
        color: null,
        classIds: [],
        tagIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      },
    ]);

    // Simulate the debounced content save applying an update_content intent.
    runtime.applyOperation({
      id: 'update-op',
      type: 'update_content',
      blockId: PARENT_UUID,
      state: 'pending',
      dependsOn: [],
      retryCount: 0,
      maxRetries: 3,
      createdAt: Date.now(),
      payload: {
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'typed content' }] }],
      },
    } as Operation);

    // The prop node still carries the stale (empty) server content, exactly as
    // the TanStack Query cache does before the next refetch.
    const flat = flattenNodesFromRuntime(
      [
        {
          uuid: PARENT_UUID,
          name: '[{"type":"paragraph","children":[{"type":"text","text":""}]}]',
          icon: null,
          color: null,
          parent_uuid: PAGE_UUID,
          page_uuid: null,
          sequence: 0,
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
      PAGE_UUID,
      false,
    );

    const node = flat.find((n) => n.node.uuid === PARENT_UUID);
    expect(node).toBeDefined();
    expect(node!.node.name).toBe('[{"type":"paragraph","children":[{"type":"text","text":"typed content"}]}]');
  });

  it('renders the root ghost as a child of the focused block in focused block view', () => {
    const runtime = new OperationRuntime();
    const focusedBlock: Node = {
      uuid: PARENT_UUID,
      name: 'Focused block',
      icon: null,
      color: null,
      parent_uuid: PAGE_UUID,
      page_uuid: null,
      sequence: 0,
      active: true,
      is_page: false,
      is_deleted: false,
      has_children: true,
      children: [
        {
          uuid: NEW_BLOCK_UUID,
          name: 'Existing child',
          icon: null,
          color: null,
          parent_uuid: PARENT_UUID,
          page_uuid: null,
          sequence: 0,
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
        },
      ],
      create_date: new Date().toISOString(),
      write_date: new Date().toISOString(),
      classes_uuid: [],
      tags_uuid: [],
      properties_uuid: {},
    };

    const flat = flattenNodesFromRuntime(
      [focusedBlock],
      -1,
      false,
      false,
      runtime,
      () => undefined,
      false,
      false,
      true,
      PARENT_UUID,
      true,
    );

    const realNodes = flat.filter((n) => !n.isGhost);
    expect(realNodes.map((n) => ({ uuid: n.node.uuid, depth: n.depth }))).toEqual([
      { uuid: PARENT_UUID, depth: 0 },
      { uuid: NEW_BLOCK_UUID, depth: 1 },
    ]);

    const ghosts = flat.filter((n) => n.isGhost);
    // Root ghost (child of focused block) + child ghost (child of existing child).
    expect(ghosts).toHaveLength(2);
    const rootGhost = ghosts.find((n) => n.node.uuid === `__ghost-${PARENT_UUID}`);
    expect(rootGhost).toBeDefined();
    expect(rootGhost!.depth).toBe(1);

    const childGhost = ghosts.find((n) => n.node.uuid === `__ghost-${NEW_BLOCK_UUID}`);
    expect(childGhost).toBeDefined();
    expect(childGhost!.depth).toBe(2);
  });

  it('creates a new block as a child of the focused block when the root ghost is realized', () => {
    const runtime = new OperationRuntime();
    runtime.loadBaseNodes([
      {
        blockId: PARENT_UUID,
        parentId: PAGE_UUID,
        orderIndex: 0,
        nodeType: 'block',
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'focused' }] }],
        collapsed: false,
        isDeleted: false,
        isPage: false,
        name: 'focused',
        icon: null,
        color: null,
        classIds: [],
        tagIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      },
      {
        blockId: NEW_BLOCK_UUID,
        parentId: PARENT_UUID,
        orderIndex: 0,
        nodeType: 'block',
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'child' }] }],
        collapsed: false,
        isDeleted: false,
        isPage: false,
        name: 'child',
        icon: null,
        color: null,
        classIds: [],
        tagIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      },
    ]);

    const newBlockId = '33333333-3333-3333-3333-333333333333';
    const runtimeChildren = runtime.getChildren(PARENT_UUID);
    const lastRealChild = runtimeChildren.length > 0 ? runtimeChildren[runtimeChildren.length - 1] : null;

    applyIntent(runtime, {
      type: 'create_block',
      parentId: PARENT_UUID,
      afterBlockId: lastRealChild?.blockId ?? null,
      blockId: newBlockId,
      contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
    });

    const newNode = runtime.getNode(newBlockId);
    expect(newNode).toBeDefined();
    expect(newNode!.parentId).toBe(PARENT_UUID);

    // Render focused block view with the focused block as the prop root.
    const focusedBlock: Node = {
      uuid: PARENT_UUID,
      name: 'focused',
      icon: null,
      color: null,
      parent_uuid: PAGE_UUID,
      page_uuid: null,
      sequence: 0,
      active: true,
      is_page: false,
      is_deleted: false,
      has_children: true,
      children: [
        {
          uuid: NEW_BLOCK_UUID,
          name: 'child',
          icon: null,
          color: null,
          parent_uuid: PARENT_UUID,
          page_uuid: null,
          sequence: 0,
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
        },
      ],
      create_date: new Date().toISOString(),
      write_date: new Date().toISOString(),
      classes_uuid: [],
      tags_uuid: [],
      properties_uuid: {},
    };

    const flat = flattenNodesFromRuntime(
      [focusedBlock],
      -1,
      false,
      false,
      runtime,
      () => undefined,
      false,
      false,
      true,
      PARENT_UUID,
      true,
    );
    const newFlatNode = flat.find((n) => n.node.uuid === newBlockId);
    expect(newFlatNode).toBeDefined();
    expect(newFlatNode!.depth).toBe(1);
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
    const shared = makeNode(SHARED_UUID);
    const tree = [
      makeNode(ROOT1_UUID, [shared]),
      makeNode(ROOT2_UUID, [makeNode(MIDDLE_UUID, [shared])]),
    ];

    const flat = flattenNodes(tree, -1, false, false, () => undefined);
    const uuids = flat.map((n) => n.node.uuid);
    expect(uuids.filter((id) => id === SHARED_UUID)).toHaveLength(1);
    expect(uuids).toEqual([...new Set(uuids)]);
  });
});
