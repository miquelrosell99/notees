/**
 * Unit tests for localNodeStore.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { del } from 'idb-keyval';
import {
  addOrUpdateNode,
  addOrUpdateNodes,
  getNode,
  getAllNodes,
  removeNode,
  clearWorkspace,
  getNodeCount,
  _resetMemoryStore,
} from './localNodeStore';
import type { Node } from '@/types/api';

const WORKSPACE = 'ws-test-1';

function makeNode(uuid: string, name: string, overrides: Partial<Node> = {}): Node {
  return {
    uuid,
    name,
    icon: null,
    color: null,
    parent_uuid: null,
    page_uuid: null,
    sequence: 0,
    active: true,
    is_page: false,
    create_date: new Date().toISOString(),
    write_date: new Date().toISOString(),
    ...overrides,
  };
}

describe('localNodeStore', () => {
  beforeEach(async () => {
    _resetMemoryStore();
    await del(`notees:nodes:${WORKSPACE}`);
  });

  it('stores and retrieves a single node', async () => {
    const node = makeNode('n1', 'Hello world');
    await addOrUpdateNode(WORKSPACE, node);
    const fetched = await getNode(WORKSPACE, 'n1');
    expect(fetched).toEqual(node);
  });

  it('updates an existing node', async () => {
    const node = makeNode('n1', 'Hello');
    await addOrUpdateNode(WORKSPACE, node);
    const updated = makeNode('n1', 'Hello world', { is_page: true });
    await addOrUpdateNode(WORKSPACE, updated);
    const fetched = await getNode(WORKSPACE, 'n1');
    expect(fetched?.name).toBe('Hello world');
    expect(fetched?.is_page).toBe(true);
  });

  it('stores many nodes in one write', async () => {
    const nodes = [makeNode('n1', 'A'), makeNode('n2', 'B'), makeNode('n3', 'C')];
    await addOrUpdateNodes(WORKSPACE, nodes);
    const all = await getAllNodes(WORKSPACE);
    expect(all).toHaveLength(3);
    expect(all.map((n) => n.uuid).sort()).toEqual(['n1', 'n2', 'n3']);
  });

  it('removes a node', async () => {
    const nodes = [makeNode('n1', 'A'), makeNode('n2', 'B')];
    await addOrUpdateNodes(WORKSPACE, nodes);
    await removeNode(WORKSPACE, 'n1');
    const all = await getAllNodes(WORKSPACE);
    expect(all).toHaveLength(1);
    expect(all[0].uuid).toBe('n2');
  });

  it('counts nodes', async () => {
    await addOrUpdateNodes(WORKSPACE, [makeNode('n1', 'A'), makeNode('n2', 'B')]);
    expect(await getNodeCount(WORKSPACE)).toBe(2);
  });

  it('isolates workspaces', async () => {
    await addOrUpdateNode(WORKSPACE, makeNode('n1', 'A'));
    await addOrUpdateNode('ws-test-2', makeNode('n1', 'B'));
    expect(await getNode(WORKSPACE, 'n1')).toMatchObject({ name: 'A' });
    expect(await getNode('ws-test-2', 'n1')).toMatchObject({ name: 'B' });
  });

  it('clears a workspace', async () => {
    await addOrUpdateNodes(WORKSPACE, [makeNode('n1', 'A'), makeNode('n2', 'B')]);
    await clearWorkspace(WORKSPACE);
    expect(await getAllNodes(WORKSPACE)).toHaveLength(0);
  });
});
