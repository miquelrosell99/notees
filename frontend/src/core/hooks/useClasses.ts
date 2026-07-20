/**
 * useClasses — local-first class list from the core workspace store.
 *
 * Replaces the legacy `/api/nodes/classes` TanStack Query hook. Classes are
 * nodes with the `isClass` flag derived from the operation log.
 */
import { useEffect, useState } from 'react';
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

  const [data, setData] = useState<Node[] | undefined>(undefined);

  useEffect(() => {
    if (!store) {
      setData(undefined);
      return;
    }
    const update = (): void => {
      setData(queryNodes(store, { isClass: true }));
    };
    update();
    return store.subscribeAll(update);
  }, [store]);

  return {
    data,
    isLoading: storeLoading,
    error: storeError,
  };
}
