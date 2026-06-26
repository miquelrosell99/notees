/**
 * React Query hooks for workspace sync protocol version.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getSyncProtocolVersion,
  setSyncProtocolVersion,
} from '../api/workspaces';
import { workspaceKeys } from '@/hooks/queryKeys';

export function useSyncProtocolVersion(workspaceUuid: string | null | undefined) {
  return useQuery({
    queryKey: workspaceKeys.syncProtocolVersion(workspaceUuid ?? ''),
    queryFn: () => getSyncProtocolVersion(workspaceUuid!),
    enabled: !!workspaceUuid,
    staleTime: 60000,
  });
}

export function useSetSyncProtocolVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceUuid, version }: { workspaceUuid: string; version: 'v1' | 'v2' }) =>
      setSyncProtocolVersion(workspaceUuid, version),
    onSuccess: (_, { workspaceUuid, version }) => {
      queryClient.setQueryData(workspaceKeys.syncProtocolVersion(workspaceUuid), {
        sync_protocol_version: version,
      });
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
    },
  });
}
