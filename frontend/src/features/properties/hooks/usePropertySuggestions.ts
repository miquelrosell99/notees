/**
 * React Query hook for property suggestions.
 *
 * Derives usage-ranked suggestions locally from the SQLite derived store.
 */
import { useParams } from 'react-router-dom';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import { propertyKeys } from '@/hooks/queryKeys';
import { useQuery } from '@tanstack/react-query';

export function usePropertySuggestions(contextNodeUuid?: string, options?: { enabled?: boolean }) {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { client, isLoading: storeLoading, error: _error } = useWorkspaceStoreClient(workspaceId ?? '');
  const enabled = options?.enabled ?? true;

  return useQuery({
    queryKey: propertyKeys.suggestions(contextNodeUuid),
    queryFn: async () => {
      if (!client) return [];
      return client.query<
        Array<{
          property_uuid: string;
          name: string;
          icon: string | null;
          type: string;
          usage_count: number;
          already_assigned: boolean;
        }>
      >('getPropertySuggestions', [contextNodeUuid]);
    },
    enabled: enabled && !storeLoading && !!client,
    staleTime: 30_000,
  });
}
