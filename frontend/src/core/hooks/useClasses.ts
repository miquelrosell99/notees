/**
 * useClasses — local-first class list from the core workspace store.
 *
 * Replaces the legacy `/api/nodes/classes` TanStack Query hook. Classes are
 * nodes with the `isClass` flag derived from the operation log.
 */
import { useMemo } from 'react';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStore } from './useWorkspaceStore';
import { queryNodes } from '../query/queryNodes';
import type { Node } from '@/types/api';

export interface UseClassesResult {
  data: Node[] | undefined;
  isLoading: boolean;
  error: Error | null;
}

export function useClasses(options?: { enabled?: boolean }): UseClassesResult {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const enabled = options?.enabled ?? true;
  const { store, isLoading: storeLoading, error: storeError } = useWorkspaceStore(
    enabled && workspaceUuid ? workspaceUuid : '',
  );

  const data = useMemo<Node[] | undefined>(() => {
    if (!store) return undefined;
    return queryNodes(store, { isClass: true });
  }, [store]);

  return {
    data,
    isLoading: storeLoading,
    error: storeError,
  };
}
