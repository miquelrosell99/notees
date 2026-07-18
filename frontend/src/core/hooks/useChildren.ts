import { useEffect, useState } from 'react';
import { useWorkspaceStore } from './useWorkspaceStore';

export interface UseChildrenResult {
  children: string[];
  isLoading: boolean;
  error: Error | null;
}

export function useChildren(workspaceId: string, parentId: string | undefined): UseChildrenResult {
  const { store, isLoading, error } = useWorkspaceStore(workspaceId);
  const [children, setChildren] = useState<string[]>([]);

  useEffect(() => {
    if (!store || !parentId) {
      setChildren([]);
      return;
    }
    const update = (): void => setChildren(store.getChildren(parentId));
    update();
    return store.subscribe(parentId, update);
  }, [store, parentId]);

  return { children, isLoading, error };
}
