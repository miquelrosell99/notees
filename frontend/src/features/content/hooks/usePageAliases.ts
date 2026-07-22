/**
 * React Query hook for fetching page aliases from the local-first core store.
 */
import { useQuery } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import type { Node } from '@/types/api';

export function usePageAliases(nodeUuid: string | null | undefined, options?: { enabled?: boolean }) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client } = useWorkspaceStoreClient(workspaceUuid ?? '');

  return useQuery<Node[], Error>({
    queryKey: nodeKeys.aliases(nodeUuid ?? ''),
    queryFn: async () => {
      if (!nodeUuid || !client) throw new Error('Node UUID or workspace store not found');
      return client.query<Node[]>('getPageAliases', [nodeUuid]);
    },
    enabled: !!nodeUuid && !!client && (options?.enabled ?? true),
  });
}
