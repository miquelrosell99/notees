import { useEffect, useState } from 'react';
import type { NodeRow } from '../store';
import { useWorkspaceStore } from './useWorkspaceStore';

export interface UseNodesResult {
  nodes: (NodeRow | undefined)[];
  isLoading: boolean;
  error: Error | null;
}

export function useNodes(workspaceId: string, nodeIds: string[]): UseNodesResult {
  const { store, isLoading, error } = useWorkspaceStore(workspaceId);
  const [nodes, setNodes] = useState<(NodeRow | undefined)[]>([]);

  useEffect(() => {
    if (!store) {
      setNodes([]);
      return;
    }
    const update = (): void => setNodes(nodeIds.map((nodeId) => store.getNode(nodeId)));
    update();
    const unsubscribes = nodeIds.map((nodeId) => store.subscribe(nodeId, update));
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [store, nodeIds]);

  return { nodes, isLoading, error };
}
