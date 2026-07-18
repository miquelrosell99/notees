/**
 * useUpdateNode
 *
 * TanStack Query mutation hook for updating nodes.
 *
 * The SQLite core path is now the default implementation. This file re-exports
 * the core adapter for backwards compatibility with existing callers.
 */

import { useUpdateNodeAdapter } from '@/core/adapters';

export function useUpdateNode() {
  return useUpdateNodeAdapter();
}
