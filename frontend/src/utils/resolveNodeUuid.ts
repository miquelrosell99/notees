import { queryClient } from '@/lib/queryClient';
import { getOperationRuntime } from '@/runtime';
import { getNodeByServerId } from '@/runtime/graphHelpers';
import { nodeViewKeys, propertyKeys } from '@/hooks/queryKeys';

/**
 * Resolve a frontend node identifier to the backend UUID.
 * String identifiers are assumed to already be UUIDs.
 * Numeric identifiers are resolved through the runtime graph first,
 * then fall back to the TanStack Query cache.
 */
export function resolveNodeUuid(id: string | number): string {
  const resolved = tryResolveNodeUuid(id);
  if (resolved === null) {
    throw new Error(`Unable to resolve UUID for node id ${id}`);
  }
  return resolved;
}

/**
 * Try to resolve a frontend node identifier to the backend UUID.
 * Returns null instead of throwing when the UUID cannot be resolved.
 */
export function tryResolveNodeUuid(id: string | number): string | null {
  if (typeof id === 'string') return id;

  const runtime = getOperationRuntime();
  const runtimeNode = getNodeByServerId(runtime, id);
  if (runtimeNode) return runtimeNode.blockId;

  return findNodeUuidInCache(id);
}

/**
 * Resolve an array of node identifiers to UUIDs.
 */
export function resolveNodeUuids(ids: (string | number)[]): string[] {
  return ids.map(resolveNodeUuid);
}

/**
 * Resolve a property identifier to its backend UUID.
 * Strings are assumed to already be UUIDs.
 * Numeric IDs are resolved by scanning property query caches.
 */
export function resolvePropertyUuid(propertyId: string | number): string | null {
  if (typeof propertyId === 'string') return propertyId;

  const queryCache = queryClient.getQueryCache();
  const candidates = queryCache.findAll({ queryKey: propertyKeys.all });
  for (const query of candidates) {
    const uuid = findUuidInData(query.state.data, propertyId, {
      uuidKeys: ['property_uuid', 'uuid'],
    });
    if (uuid) return uuid;
  }
  return null;
}

/**
 * Resolve a NodeView identifier to its backend UUID.
 * Strings are assumed to already be UUIDs.
 * Numeric IDs are resolved by scanning node-view query caches.
 */
export function resolveNodeViewUuid(viewId: string | number): string | null {
  if (typeof viewId === 'string') return viewId;

  const queryCache = queryClient.getQueryCache();
  const candidates = queryCache.findAll({ queryKey: nodeViewKeys.all });
  for (const query of candidates) {
    const uuid = findUuidInData(query.state.data, viewId, { uuidKeys: ['uuid'] });
    if (uuid) return uuid;
  }
  return null;
}

function findNodeUuidInCache(nodeId: number): string | null {
  const queryCache = queryClient.getQueryCache();
  const candidates = [
    ...queryCache.findAll({ queryKey: ['nodes', 'detail'] }),
    ...queryCache.findAll({ queryKey: ['nodes', 'page-content'] }),
    ...queryCache.findAll({ queryKey: ['nodes', 'uuid'] }),
    ...queryCache.findAll({ queryKey: ['nodes', 'graph-nodes'] }),
  ];
  for (const query of candidates) {
    const uuid = findUuidInData(query.state.data, nodeId);
    if (uuid) return uuid;
  }
  return null;
}

function findUuidInData(
  data: unknown,
  targetId: number,
  options: { uuidKeys: string[] } = { uuidKeys: ['uuid'] }
): string | null {
  const { uuidKeys } = options;

  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findUuidInData(item, targetId, options);
      if (found) return found;
    }
    return null;
  }

  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (typeof record.id === 'number' && record.id === targetId) {
      for (const key of uuidKeys) {
        const value = record[key];
        if (typeof value === 'string' && value.length > 0) {
          return value;
        }
      }
    }

    for (const value of Object.values(record)) {
      if (Array.isArray(value)) {
        const found = findUuidInData(value, targetId, options);
        if (found) return found;
      }
    }
  }

  return null;
}
