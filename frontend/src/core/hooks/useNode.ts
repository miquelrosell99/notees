import { useEffect, useState } from 'react';
import type { NodeRow } from '../store';
import { useWorkspaceStore } from './useWorkspaceStore';

export interface UseNodeResult {
  node: NodeRow | undefined;
  isLoading: boolean;
  error: Error | null;
}

export function useNode(workspaceId: string, nodeId: string | undefined): UseNodeResult {
  const { store, isLoading, error } = useWorkspaceStore(workspaceId);
  const [node, setNode] = useState<NodeRow | undefined>(undefined);

  useEffect(() => {
    if (!store || !nodeId) {
      setNode(undefined);
      return;
    }
    const update = (): void => setNode(store.getNode(nodeId));
    update();
    return store.subscribe(nodeId, update);
  }, [store, nodeId]);

  return { node, isLoading, error };
}
