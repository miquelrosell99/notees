/**
 * useSetNodeProperty
 *
 * TanStack Query mutation hook for setting or removing a property value on a
 * node. The SQLite core path is now the sole implementation.
 */
import { useSetNodePropertyAdapter } from '@/core/adapters';

export function useSetNodeProperty() {
  return useSetNodePropertyAdapter();
}
