import { useEffect, useState } from 'react';
import type { NodeRow } from '../store';
import { useWorkspaceStoreClient } from './useWorkspaceStoreClient';

export interface UseNodesResult {
  nodes: (NodeRow | undefined)[];
  isLoading: boolean;
  error: Error | null;
}

export function useNodes(workspaceId: string, nodeIds: string[]): UseNodesResult {
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceId);
  const [nodes, setNodes] = useState<(NodeRow | undefined)[]>([]);

  useEffect(() => {
    if (!client) {
      setNodes([]);
      return;
    }

    let cancelled = false;

    const update = async (): Promise<void> => {
      const nextNodes = await Promise.all(
        nodeIds.map((nodeId) => client.query<NodeRow | undefined>('getNode', [nodeId])),
      );
      if (!cancelled) {
        setNodes(nextNodes);
      }
    };

    update();
    const unsubscribes = nodeIds.map((nodeId) => client.subscribe(nodeId, update));
    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [client, nodeIds]);

  return { nodes, isLoading, error };
}
