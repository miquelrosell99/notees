/**
 * Pure graph helpers over OperationRuntime.
 *
 * These used to live on the NodeGraphRuntime facade. They are now standalone
 * functions so the runtime core stays focused on derived state.
 */

import type { OperationRuntime } from './OperationRuntime';
import { coreNodeToGraphNode } from './nodeMapping';
import type { GraphNode } from './types';

function toGraph(core: ReturnType<OperationRuntime['getNode']>): GraphNode | undefined {
  return core ? coreNodeToGraphNode(core) : undefined;
}

export function getNode(runtime: OperationRuntime, blockId: string): GraphNode | undefined {
  return toGraph(runtime.getNode(blockId));
}

export function getChildren(runtime: OperationRuntime, parentId: string | null): GraphNode[] {
  return runtime.getChildren(parentId).map(coreNodeToGraphNode);
}

export function getSiblings(runtime: OperationRuntime, blockId: string): GraphNode[] {
  const node = runtime.getNode(blockId);
  if (!node?.parentId) return [];
  return getChildren(runtime, node.parentId);
}

export function getDescendants(runtime: OperationRuntime, blockId: string): GraphNode[] {
  const result: GraphNode[] = [];
  const stack = [blockId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const children = runtime.getChildren(current);
    for (const child of children) {
      result.push(coreNodeToGraphNode(child));
      stack.push(child.blockId);
    }
  }
  return result;
}

export function getAncestors(runtime: OperationRuntime, blockId: string): GraphNode[] {
  const result: GraphNode[] = [];
  let current = runtime.getNode(blockId);
  while (current?.parentId) {
    const parent = runtime.getNode(current.parentId);
    if (!parent) break;
    result.push(coreNodeToGraphNode(parent));
    current = parent;
  }
  return result;
}

export function getAllNodes(runtime: OperationRuntime): GraphNode[] {
  return [...runtime.snapshot().projectedNodes.values()].map(coreNodeToGraphNode);
}

export function getAllPages(runtime: OperationRuntime): GraphNode[] {
  return [...runtime.snapshot().projectedNodes.values()]
    .filter((n) => n.isPage && !n.isDeleted)
    .map(coreNodeToGraphNode);
}

export function getUnpersistedNodes(runtime: OperationRuntime): GraphNode[] {
  const result: GraphNode[] = [];
  for (const node of runtime.snapshot().projectedNodes.values()) {
    if (!node.blockId.startsWith('__')) {
      result.push(coreNodeToGraphNode(node));
    }
  }
  return result;
}

export function getNodeByServerId(runtime: OperationRuntime, blockId: string): GraphNode | null {
  const node = runtime.getNode(blockId);
  return node ? coreNodeToGraphNode(node) : null;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns true for IDs that can plausibly be persisted server-side node UUIDs.
 *
 * Rejects:
 * - ghost pseudo-block IDs (`__ghost-*`)
 * - virtual root IDs created when no single parent exists (`vroot-*`)
 * - the zero/pseudo UUID used for synthetic collections
 * - empty or non-UUID strings
 *
 * This is a cheap client-side guard. It does not guarantee the node exists on
 * the server, but it prevents obviously-invalid parents from being used in
 * create/move operations.
 */
export function isValidServerNodeId(blockId: string | null | undefined): boolean {
  if (!blockId) return false;
  if (blockId.startsWith('__ghost-') || blockId.startsWith('vroot-')) return false;
  if (blockId === '00000000-0000-0000-0000-000000000000') return false;
  return UUID_REGEX.test(blockId);
}
