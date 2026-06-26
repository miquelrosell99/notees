import { queryClient } from '@/lib/queryClient';
import { propertyKeys } from '@/hooks/queryKeys';

/**
 * Resolve a frontend node identifier to the backend UUID.
 * Node identifiers are now UUID strings; numeric resolution is obsolete.
 */
export function resolveNodeUuid(id: string): string {
  return id;
}

/**
 * Try to resolve a frontend node identifier to the backend UUID.
 * Returns the input string unchanged.
 */
export function tryResolveNodeUuid(id: string): string | null {
  return id;
}

/**
 * Resolve an array of node identifiers to UUIDs.
 */
export function resolveNodeUuids(ids: string[]): string[] {
  return ids;
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
 * NodeView identifiers are now UUID strings; numeric IDs are obsolete.
 */
export function resolveNodeViewUuid(viewId: string | number): string | null {
  return typeof viewId === 'string' ? viewId : null;
}

function findUuidInData(
  data: unknown,
  targetId: string | number,
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
