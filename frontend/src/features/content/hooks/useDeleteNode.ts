/**
 * useDeleteNode
 *
 * TanStack Query mutation hook for deleting nodes.
 *
 * The SQLite core path is now the default implementation. This file re-exports
 * the core adapter for backwards compatibility with existing callers.
 */

import { useDeleteNodeAdapter } from '@/core/adapters';

export function useDeleteNode() {
  return useDeleteNodeAdapter();
}
