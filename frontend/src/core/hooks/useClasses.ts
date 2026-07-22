/**
 * useClasses — local-first class list from the core workspace store.
 *
 * Replaces the legacy `/api/nodes/classes` TanStack Query hook. Classes are
 * nodes with the `isClass` flag derived from the operation log.
 *
 * TODO: Migrate to the async WorkspaceStoreClient. This hook relies on
 * `queryNodes`, which is not a WorkspaceStore method and cannot be invoked
 * through the generic client.query handler. Migrate `queryNodes` to the worker
 * first, then switch this hook to `useWorkspaceStoreClient`.
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
      setData(queryNodes(store, { isClass: true, projectionDepth: 0 }));
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
