/**
 * useCreateNode
 *
 * TanStack Query mutation hook for creating nodes.
 *
 * The SQLite core path is now the default implementation. This file re-exports
 * the core adapter for backwards compatibility with existing callers.
 */

import { useCreateNodeAdapter } from '@/core/adapters';

export function useCreateNode() {
  return useCreateNodeAdapter();
}
