/**
 * Property Query Hooks
 *
 * The SQLite core path is now the default implementation. Public hooks re-export
 * the core adapters for backwards compatibility with existing callers.
 */

import {
  usePropertiesAdapter,
  useAvailablePropertiesAdapter,
  usePropertyAdapter,
  useBatchPropertyValuesAdapter,
} from '@/core/adapters/usePropertiesAdapter';

export function useProperties() {
  return usePropertiesAdapter();
}

export function useAvailableProperties(opts: {
  contextNodeId?: string;
  contextClassIds?: string[];
} = {}) {
  return useAvailablePropertiesAdapter(opts);
}

export function useProperty(id: string | null) {
  return usePropertyAdapter(id);
}

export function useBatchPropertyValues(nodeUuids: string[]) {
  return useBatchPropertyValuesAdapter(nodeUuids);
}
