/**
 * Tests for useBlockTree projection helpers.
 *
 * The hook now derives the tree from the local-first core store. These tests
 * cover the static fallback and the store-backed projection helper.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { renderHook, waitFor } from '@testing-library/react';
import { WorkspaceStore } from '@/core/store';
import { uuidv7 } from '@/core/uuid';
import { createTestDatabase } from '@/core/__tests__/helpers';
import { createWorkspaceStoreClient } from '@/core/worker/WorkspaceStoreClient';
import { GetNodeTreeQuery } from '@/core/graphQueries/queries/GetNodeTreeQuery';
import { useWorkspaceStoreClient } from '@/core/hooks';
import { useGraphQuery } from '@/core/graphQueries/hooks/useGraphQuery';
import { flattenNodes, isGhostId, buildGhostId, parseGhostParentUuid } from './useBlockTree';
import { buildFlatNodesFromStore } from './useBlockTree.store';
import { useBlockTree } from './useBlockTree';
import type { Node } from '@/types/api';

vi.mock('@/features/sync', () => ({
  useUIStateStore: vi.fn(() => ({})),
}));

vi.mock('react-router-dom', () => ({
  useParams: vi.fn(() => ({ workspaceId: 'ws-test' })),
}));

vi.mock('@/core/hooks', () => ({
  useWorkspaceStoreClient: vi.fn(() => ({ client: undefined, isLoading: false, error: null })),
}));

vi.mock('@/core/graphQueries/hooks/useGraphQuery', () => ({
  useGraphQuery: vi.fn(() => ({ data: undefined, isLoading: false, error: null, refetch: vi.fn() })),
}));

const PAGE_UUID = '11111111-1111-1111-1111-111111111111';
const PARENT_UUID = '22222222-2222-2222-2222-222222222222';
const NEW_CHILD_UUID = '44444444-4444-4444-4444-444444444444';
const ROOT_UUID = '55555555-5555-5555-5555-555555555555';
const ROOT1_UUID = '66666666-6666-6666-6666-666666666666';
const ROOT2_UUID = '77777777-7777-7777-7777-777777777777';
const SHARED_UUID = '88888888-8888-8888-8888-888888888888';

async function createTestStore(): Promise<WorkspaceStore> {
  const db = await createTestDatabase();
  return new WorkspaceStore(db, uuidv7(), uuidv7());
}

function makeNode(uuid: string, overrides: Partial<Node> = {}): Node {
  return {
    uuid,
    name: uuid,
    icon: null,
    color: null,
    parent_uuid: null,
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
    ...overrides,
  } as Node;
}

describe('buildFlatNodesFromStore', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  it('renders children of a root page from the core store', async () => {
    const store = await createTestStore();
    store.createNode({ nodeId: PAGE_UUID, kind: 'page', parentId: null });
    store.createNode({ nodeId: PARENT_UUID, kind: 'block', parentId: null });
    store.moveNode(PARENT_UUID, PAGE_UUID);
    store.updateText(PARENT_UUID, (text) => text.insert(0, 'Parent block'));

    const flat = buildFlatNodesFromStore(
      store,
      [],
      { nodeUuid: PAGE_UUID, readOnly: true },
      () => undefined,
    );

    const realNodes = flat.filter((n) => !n.isGhost);
    expect(realNodes).toHaveLength(1);
    expect(realNodes[0].node.uuid).toBe(PARENT_UUID);
    expect(realNodes[0].depth).toBe(0);
  });

  it('renders nested children recursively', async () => {
    const store = await createTestStore();
    store.createNode({ nodeId: PAGE_UUID, kind: 'page', parentId: null });
    store.createNode({ nodeId: PARENT_UUID, kind: 'block', parentId: null });
    store.createNode({ nodeId: NEW_CHILD_UUID, kind: 'block', parentId: null });
    store.moveNode(PARENT_UUID, PAGE_UUID);
    store.moveNode(NEW_CHILD_UUID, PARENT_UUID);
    store.updateText(PARENT_UUID, (text) => text.insert(0, 'Parent'));
    store.updateText(NEW_CHILD_UUID, (text) => text.insert(0, 'Child'));

    const flat = buildFlatNodesFromStore(
      store,
      [],
      { nodeUuid: PAGE_UUID, readOnly: true },
      () => undefined,
    );

    const child = flat.find((n) => n.node.uuid === NEW_CHILD_UUID);
    expect(child).toBeDefined();
    expect(child!.depth).toBe(1);
  });

  it('does not render deleted nodes', async () => {
    const store = await createTestStore();
    store.createNode({ nodeId: PAGE_UUID, kind: 'page', parentId: null });
    store.createNode({ nodeId: PARENT_UUID, kind: 'block', parentId: null });
    store.moveNode(PARENT_UUID, PAGE_UUID);
    store.deleteNode(PARENT_UUID);

    const flat = buildFlatNodesFromStore(
      store,
      [makeNode(PARENT_UUID, { parent_uuid: PAGE_UUID })],
      { nodeUuid: PAGE_UUID, readOnly: true },
      () => undefined,
    );

    expect(flat.some((n) => n.node.uuid === PARENT_UUID)).toBe(false);
  });

  it('renders each node once even when a UUID appears in multiple tree branches', async () => {
    const store = await createTestStore();
    store.createNode({ nodeId: ROOT_UUID, kind: 'page', parentId: null });
    store.createNode({ nodeId: ROOT1_UUID, kind: 'block', parentId: null });
    store.createNode({ nodeId: ROOT2_UUID, kind: 'block', parentId: null });
    store.createNode({ nodeId: SHARED_UUID, kind: 'block', parentId: null });
    store.moveNode(ROOT1_UUID, ROOT_UUID);
    store.moveNode(ROOT2_UUID, ROOT_UUID);
    store.moveNode(SHARED_UUID, ROOT1_UUID);

    // Duplicate the shared node under root2 as well.
    store.getDb().run('INSERT OR IGNORE INTO node_child_order (parent_id, child_id, position) VALUES (?, ?, ?)', [
      ROOT2_UUID,
      SHARED_UUID,
      '2',
    ]);

    const flat = buildFlatNodesFromStore(
      store,
      [],
      { nodeUuid: ROOT_UUID, readOnly: true },
      () => undefined,
    );

    const realUuids = flat.filter((n) => !n.isGhost).map((n) => n.node.uuid);
    expect(realUuids).toEqual([...new Set(realUuids)]);
    expect(realUuids.filter((id) => id === SHARED_UUID)).toHaveLength(1);
  });

  it('renders the focused block and its children in focused block view', async () => {
    const store = await createTestStore();
    store.createNode({ nodeId: PAGE_UUID, kind: 'page', parentId: null });
    store.createNode({ nodeId: PARENT_UUID, kind: 'block', parentId: null });
    store.createNode({ nodeId: 'child-uuid', kind: 'block', parentId: null });
    store.moveNode(PARENT_UUID, PAGE_UUID);
    store.moveNode('child-uuid', PARENT_UUID);
    store.updateText(PARENT_UUID, (text) => text.insert(0, 'Focused block'));
    store.updateText('child-uuid', (text) => text.insert(0, 'Existing child'));

    const flat = buildFlatNodesFromStore(
      store,
      [makeNode(PARENT_UUID, { parent_uuid: PAGE_UUID, has_children: true })],
      { nodeUuid: PARENT_UUID, readOnly: false, rootIsBlock: true },
      () => undefined,
    );

    const realNodes = flat.filter((n) => !n.isGhost);
    expect(realNodes.map((n) => ({ uuid: n.node.uuid, depth: n.depth }))).toEqual([
      { uuid: PARENT_UUID, depth: 0 },
      { uuid: 'child-uuid', depth: 1 },
    ]);

    const ghosts = flat.filter((n) => n.isGhost);
    const rootGhost = ghosts.find((n) => n.node.uuid === buildGhostId(PARENT_UUID));
    expect(rootGhost).toBeDefined();
    expect(rootGhost!.depth).toBe(1);
  });

  it('appends trailing ghost blocks for non-read-only lists', async () => {
    const store = await createTestStore();
    store.createNode({ nodeId: PAGE_UUID, kind: 'page', parentId: null });

    const flat = buildFlatNodesFromStore(
      store,
      [],
      { nodeUuid: PAGE_UUID, readOnly: false },
      () => undefined,
    );

    expect(flat.some((n) => n.isGhost && n.node.uuid === buildGhostId(PAGE_UUID))).toBe(true);
  });
});

describe('flattenNodes', () => {
  it('renders each node once when a UUID appears in multiple tree branches', () => {
    const shared = makeNode(SHARED_UUID);
    const tree = [
      makeNode(ROOT1_UUID, { children: [shared] }),
      makeNode(ROOT2_UUID, { children: [makeNode('middle', { children: [shared] })] }),
    ];

    const flat = flattenNodes(tree, -1, false, false, () => undefined);
    const uuids = flat.map((n) => n.node.uuid);
    expect(uuids.filter((id) => id === SHARED_UUID)).toHaveLength(1);
    expect(uuids).toEqual([...new Set(uuids)]);
  });
});

describe('ghost helpers', () => {
  it('detects ghost ids', () => {
    expect(isGhostId('__ghost-abc')).toBe(true);
    expect(isGhostId('abc')).toBe(false);
  });

  it('round-trips ghost parent uuid', () => {
    expect(parseGhostParentUuid(buildGhostId('parent-uuid'))).toBe('parent-uuid');
    expect(parseGhostParentUuid('regular-uuid')).toBeNull();
  });
});

describe('useBlockTree', () => {
  it('falls back to static flattening when no core store is available', () => {
    const tree = [makeNode('a'), makeNode('b', { children: [makeNode('c')] })];
    const { result } = renderHook(() => useBlockTree(tree));

    expect(result.current.flatNodes.map((n) => n.node.uuid)).toEqual(['a', 'b', 'c']);
  });

  it('projects local-only nodes and appends a root ghost block', () => {
    const tree = [makeNode('a'), makeNode('b')];
    const { result } = renderHook(() =>
      useBlockTree(tree, { nodeUuid: PAGE_UUID, localOnly: true }),
    );

    const uuids = result.current.flatNodes.map((n) => n.node.uuid);
    expect(uuids).toEqual(['a', 'b', buildGhostId(PAGE_UUID)]);
    const ghost = result.current.flatNodes.find((n) => n.isGhost);
    expect(ghost).toBeDefined();
    expect(ghost!.node.uuid).toBe(buildGhostId(PAGE_UUID));
  });

  it('uses GetNodeTreeQuery and does not call getChildren', async () => {
    const store = await createTestStore();
    store.createNode({ nodeId: PAGE_UUID, kind: 'page', parentId: null });
    store.createNode({ nodeId: PARENT_UUID, kind: 'block', parentId: null });
    store.createNode({ nodeId: NEW_CHILD_UUID, kind: 'block', parentId: null });
    store.moveNode(PARENT_UUID, PAGE_UUID);
    store.moveNode(NEW_CHILD_UUID, PARENT_UUID);
    store.updateText(PARENT_UUID, (text) => text.insert(0, 'Parent'));
    store.updateText(NEW_CHILD_UUID, (text) => text.insert(0, 'Child'));

    const client = createWorkspaceStoreClient();
    await client.init(uuidv7(), uuidv7(), { store });

    const mockedUseWorkspaceStoreClient = vi.mocked(useWorkspaceStoreClient);
    mockedUseWorkspaceStoreClient.mockReturnValue({ client, isLoading: false, error: null });

    const rows = GetNodeTreeQuery.execute(store, { nodeUuid: PAGE_UUID, maxDepth: -1 }).rows;
    const mockedUseGraphQuery = vi.mocked(useGraphQuery);
    mockedUseGraphQuery.mockReturnValue({
      data: { rows },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    const querySpy = vi.spyOn(client, 'query');

    const { result } = renderHook(() => useBlockTree([], { nodeUuid: PAGE_UUID, readOnly: true }));

    await waitFor(() => expect(result.current.flatNodes.length).toBeGreaterThan(0));

    const realUuids = result.current.flatNodes.filter((n) => !n.isGhost).map((n) => n.node.uuid);
    expect(realUuids).toContain(PARENT_UUID);
    expect(realUuids).toContain(NEW_CHILD_UUID);

    const getChildrenCalls = querySpy.mock.calls.filter((call) => call[0] === 'getChildren');
    expect(getChildrenCalls).toHaveLength(0);

    querySpy.mockRestore();
    client.close();
  });
});
