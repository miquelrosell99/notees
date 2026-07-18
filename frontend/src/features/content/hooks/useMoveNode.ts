/**
 * useMoveNode
 *
 * TanStack Query mutation hook for moving nodes.
 *
 * The SQLite core path is now the default implementation. This file re-exports
 * the core adapter for backwards compatibility with existing callers.
 */

import { useMoveNodeAdapter } from '@/core/adapters';

export function useMoveNode() {
  return useMoveNodeAdapter();
}
