/**
 * localNodeStore — persisted workspace-scoped mirror of nodes for offline use.
 *
 * This is NOT the primary source of truth; TanStack Query + OperationRuntime
 * still own authoritative state. The mirror is a read-only fallback that is
 * kept warm by indexing successful server responses and local mutations.
 *
 * Storage: IndexedDB via idb-keyval, with an in-memory fallback for jsdom tests.
 */

import { get, set, del } from 'idb-keyval';
import type { Node } from '@/types/api';

const STORAGE_KEY_PREFIX = 'notees:nodes';

const memoryStore = new Map<string, Record<string, Node>>();
const hasIndexedDB = typeof indexedDB !== 'undefined';

function workspaceKey(workspaceUuid: string): string {
  return `${STORAGE_KEY_PREFIX}:${workspaceUuid}`;
}

async function idbGet(workspaceUuid: string): Promise<Record<string, Node> | undefined> {
  const key = workspaceKey(workspaceUuid);
  if (hasIndexedDB) {
    return get<Record<string, Node>>(key);
  }
  return memoryStore.get(key);
}

async function idbSet(workspaceUuid: string, value: Record<string, Node>): Promise<void> {
  const key = workspaceKey(workspaceUuid);
  if (hasIndexedDB) {
    await set(key, value);
  } else {
    memoryStore.set(key, value);
  }
}

async function idbDelete(workspaceUuid: string): Promise<void> {
  const key = workspaceKey(workspaceUuid);
  if (hasIndexedDB) {
    await del(key);
  } else {
    memoryStore.delete(key);
  }
}

async function loadRecord(workspaceUuid: string): Promise<Record<string, Node>> {
  return (await idbGet(workspaceUuid)) ?? {};
}

/**
 * Add or update a single node in the local mirror.
 */
export async function addOrUpdateNode(
  workspaceUuid: string,
  node: Node,
): Promise<void> {
  const record = await loadRecord(workspaceUuid);
  record[node.uuid] = node;
  await idbSet(workspaceUuid, record);
}

/**
 * Add or update many nodes at once (single IndexedDB write).
 */
export async function addOrUpdateNodes(
  workspaceUuid: string,
  nodes: Node[],
): Promise<void> {
  if (nodes.length === 0) return;
  const record = await loadRecord(workspaceUuid);
  for (const node of nodes) {
    record[node.uuid] = node;
  }
  await idbSet(workspaceUuid, record);
}

/**
 * Remove a node from the local mirror (e.g. soft-delete or purge).
 */
export async function removeNode(
  workspaceUuid: string,
  nodeUuid: string,
): Promise<void> {
  const record = await loadRecord(workspaceUuid);
  delete record[nodeUuid];
  await idbSet(workspaceUuid, record);
}

/**
 * Fetch a single node from the local mirror.
 */
export async function getNode(
  workspaceUuid: string,
  nodeUuid: string,
): Promise<Node | undefined> {
  const record = await loadRecord(workspaceUuid);
  return record[nodeUuid];
}

/**
 * Fetch all mirrored nodes for a workspace.
 */
export async function getAllNodes(workspaceUuid: string): Promise<Node[]> {
  const record = await loadRecord(workspaceUuid);
  return Object.values(record);
}

/**
 * Return the number of mirrored nodes in a workspace.
 */
export async function getNodeCount(workspaceUuid: string): Promise<number> {
  const record = await loadRecord(workspaceUuid);
  return Object.keys(record).length;
}

/**
 * Wipe the local mirror for a workspace. Use on logout or workspace switch.
 */
export async function clearWorkspace(workspaceUuid: string): Promise<void> {
  await idbDelete(workspaceUuid);
}

/**
 * Reset the entire in-memory fallback. Intended for tests only.
 */
export function _resetMemoryStore(): void {
  memoryStore.clear();
}
