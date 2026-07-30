import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../../store';
import { uuidv7 } from '../../uuid';
import { createTestDatabase } from '../../__tests__/helpers';
import { GetNodeTreeQuery } from '../../graphQueries/queries/GetNodeTreeQuery';
import { buildFlatNodesFromStore, getVisibleNodeIds } from '../NodeTreeProjection';

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

async function makeStore() {
  const db = await createTestDatabase();
  const workspaceId = uuidv7();
  const actorId = uuidv7();
  return new WorkspaceStore(db, workspaceId, actorId);
}

const PAGE_UUID = '11111111-1111-1111-1111-111111111111';
const PARENT_UUID = '22222222-2222-2222-2222-222222222222';
const CHILD_UUID = '44444444-4444-4444-4444-444444444444';

describe('NodeTreeProjection', () => {
  it('builds FlatNode[] from store rows', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: PAGE_UUID, kind: 'page', parentId: null });
    store.createNode({ nodeId: PARENT_UUID, kind: 'block', parentId: null });
    store.createNode({ nodeId: CHILD_UUID, kind: 'block', parentId: null });
    store.moveNode(PARENT_UUID, PAGE_UUID);
    store.moveNode(CHILD_UUID, PARENT_UUID);

    const rows = GetNodeTreeQuery.execute(store, { nodeUuid: PAGE_UUID, maxDepth: -1 }).rows;
    const flat = buildFlatNodesFromStore(store, rows, { nodeUuid: PAGE_UUID, readOnly: true }, () => undefined);

    const realNodes = flat.filter((n) => !n.isGhost);
    expect(realNodes.map((n) => ({ uuid: n.node.uuid, depth: n.depth }))).toEqual([
      { uuid: PARENT_UUID, depth: 0 },
      { uuid: CHILD_UUID, depth: 1 },
    ]);
  });

  it('respects collapsed state', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: PAGE_UUID, kind: 'page', parentId: null });
    store.createNode({ nodeId: PARENT_UUID, kind: 'block', parentId: null });
    store.createNode({ nodeId: CHILD_UUID, kind: 'block', parentId: null });
    store.moveNode(PARENT_UUID, PAGE_UUID);
    store.moveNode(CHILD_UUID, PARENT_UUID);

    const rows = GetNodeTreeQuery.execute(store, { nodeUuid: PAGE_UUID, maxDepth: -1 }).rows;
    const flat = buildFlatNodesFromStore(
      store,
      rows,
      { nodeUuid: PAGE_UUID, readOnly: true },
      (id) => (id === PARENT_UUID ? true : undefined)
    );

    const realNodes = flat.filter((n) => !n.isGhost);
    expect(realNodes.map((n) => n.node.uuid)).toEqual([PARENT_UUID]);
  });

  it('respects maxDepth', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: PAGE_UUID, kind: 'page', parentId: null });
    store.createNode({ nodeId: PARENT_UUID, kind: 'block', parentId: null });
    store.createNode({ nodeId: CHILD_UUID, kind: 'block', parentId: null });
    store.moveNode(PARENT_UUID, PAGE_UUID);
    store.moveNode(CHILD_UUID, PARENT_UUID);

    const rows = GetNodeTreeQuery.execute(store, { nodeUuid: PAGE_UUID, maxDepth: -1 }).rows;
    const flat = buildFlatNodesFromStore(store, rows, { nodeUuid: PAGE_UUID, readOnly: true, maxDepth: 0 }, () => undefined);

    const realNodes = flat.filter((n) => !n.isGhost);
    expect(realNodes.map((n) => n.node.uuid)).toEqual([PARENT_UUID]);
  });

  it('renders the focused block root and its children', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: PAGE_UUID, kind: 'page', parentId: null });
    store.createNode({ nodeId: PARENT_UUID, kind: 'block', parentId: null });
    store.createNode({ nodeId: CHILD_UUID, kind: 'block', parentId: null });
    store.moveNode(PARENT_UUID, PAGE_UUID);
    store.moveNode(CHILD_UUID, PARENT_UUID);

    const rows = GetNodeTreeQuery.execute(store, { nodeUuid: PARENT_UUID, maxDepth: -1 }).rows;
    const flat = buildFlatNodesFromStore(
      store,
      rows,
      { nodeUuid: PARENT_UUID, readOnly: false, rootIsBlock: true },
      () => undefined
    );

    const realNodes = flat.filter((n) => !n.isGhost);
    expect(realNodes.map((n) => ({ uuid: n.node.uuid, depth: n.depth }))).toEqual([
      { uuid: PARENT_UUID, depth: 0 },
      { uuid: CHILD_UUID, depth: 1 },
    ]);

    const rootGhost = flat.find((n) => n.isGhost && n.node.uuid === `__ghost-${PARENT_UUID}`);
    expect(rootGhost).toBeDefined();
    expect(rootGhost!.depth).toBe(1);
  });

  it('computes visible ids excluding collapsed subtrees', async () => {
    const store = await makeStore();
    store.createNode({ nodeId: PAGE_UUID, kind: 'page', parentId: null });
    store.createNode({ nodeId: PARENT_UUID, kind: 'block', parentId: null });
    store.createNode({ nodeId: CHILD_UUID, kind: 'block', parentId: null });
    store.moveNode(PARENT_UUID, PAGE_UUID);
    store.moveNode(CHILD_UUID, PARENT_UUID);

    const rows = GetNodeTreeQuery.execute(store, { nodeUuid: PAGE_UUID, maxDepth: -1 }).rows;
    const visible = getVisibleNodeIds(
      rows,
      { nodeUuid: PAGE_UUID },
      (id) => (id === PARENT_UUID ? true : undefined)
    );

    expect(visible.has(PAGE_UUID)).toBe(false);
    expect(visible.has(PARENT_UUID)).toBe(true);
    expect(visible.has(CHILD_UUID)).toBe(false);
  });
});
