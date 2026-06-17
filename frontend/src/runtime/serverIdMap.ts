/**
 * serverIdMap — bidirectional blockId ↔ serverId mapping.
 *
 * OperationRuntime stores serverId on nodes when they are loaded, but some
 * callers (create flows, lazy-child loading) need to resolve numeric server IDs
 * for nodes that have not been fully materialised as graph nodes yet. This
 * small module holds that mapping outside the runtime core.
 */

import type { OperationRuntime } from './OperationRuntime';
import { coreNodeToGraphNode } from './nodeMapping';
import type { GraphNode } from './types';

const blockToServer = new Map<string, number>();
const serverToBlock = new Map<number, string>();

export function registerServerId(blockId: string, serverId: number): void {
  blockToServer.set(blockId, serverId);
  serverToBlock.set(serverId, blockId);
}

export function getServerId(blockId: string): number | null {
  return blockToServer.get(blockId) ?? null;
}

export function getBlockId(serverId: number): string | null {
  return serverToBlock.get(serverId) ?? null;
}

export function clearServerId(blockId: string): void {
  const serverId = blockToServer.get(blockId);
  if (serverId !== undefined) {
    serverToBlock.delete(serverId);
    blockToServer.delete(blockId);
  }
}

/**
 * Update the runtime node's serverId and keep the mapping in sync.
 */
export function setServerId(runtime: OperationRuntime, blockId: string, serverId: number): void {
  registerServerId(blockId, serverId);
  const baseNode = runtime.snapshot().baseNodes.get(blockId);
  if (baseNode) {
    runtime.upsertBaseNodes([{ ...baseNode, serverId }]);
  }
}

/**
 * Resolve a node by its numeric server ID, using the runtime first and the
 * fallback map second.
 */
export function getNodeByServerId(runtime: OperationRuntime, serverId: number): GraphNode | null {
  // Fast path: scan projected nodes for the server id.
  for (const node of runtime.snapshot().projectedNodes.values()) {
    if (node.serverId === serverId) return coreNodeToGraphNode(node);
  }
  // Fallback mapping for nodes not loaded into the runtime projection.
  const blockId = serverToBlock.get(serverId);
  if (!blockId) return null;
  const node = runtime.getNode(blockId);
  return node ? coreNodeToGraphNode(node) : null;
}

/**
 * Register a parent serverId without requiring the parent to be a full node.
 */
export function registerParentServerId(parentBlockId: string, serverId: number): void {
  registerServerId(parentBlockId, serverId);
}

/**
 * Resolve a parent serverId from the runtime or the fallback map.
 *
 * The runtime stores parent references as block UUIDs, so this helper first
 * looks up the associated numeric server id. As a fallback, it also accepts
 * parent ids that are already numeric strings (used in some tests and legacy
 * flows). Pure UUIDs that cannot be resolved return `null` instead of being
 * incorrectly parsed into a random integer.
 */
export function resolveParentServerId(runtime: OperationRuntime, parentBlockId: string): number | null {
  const node = runtime.getNode(parentBlockId);
  if (node?.serverId != null) return node.serverId;
  const mapped = getServerId(parentBlockId);
  if (mapped != null) return mapped;
  if (/^\d+$/.test(parentBlockId)) {
    return parseInt(parentBlockId, 10);
  }
  return null;
}

/**
 * Remap a temporary blockId to the server's blockId. This updates the mapping
 * without mutating runtime node keys — the runtime now uses client-generated
 * UUIDs consistently and relies on server-driven base-state updates to bring
 * in the canonical block.
 */
export function remapBlockId(oldBlockId: string, newBlockId: string): void {
  const serverId = blockToServer.get(oldBlockId);
  if (serverId !== undefined) {
    blockToServer.delete(oldBlockId);
    blockToServer.set(newBlockId, serverId);
    serverToBlock.set(serverId, newBlockId);
  }
}
