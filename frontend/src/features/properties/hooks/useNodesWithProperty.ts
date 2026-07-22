/**
 * useNodesWithProperty
 */
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import { propertyKeys } from '@/hooks/queryKeys';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';

export function useNodesWithProperty(propertyUuid: string | null) {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { client, isLoading: storeLoading, error: _error } = useWorkspaceStoreClient(workspaceId ?? '');

  return useQuery({
    queryKey: propertyKeys.nodes(propertyUuid ?? ''),
    queryFn: async () => {
      if (!client || !propertyUuid) return [];
      return client.query<Node[]>('getNodesWithProperty', [propertyUuid]);
    },
    enabled: !!propertyUuid && !storeLoading && !!client,
    staleTime: 30000,
  });
}
