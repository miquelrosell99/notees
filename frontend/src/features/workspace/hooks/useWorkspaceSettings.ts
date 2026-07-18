/**
 * React Query hook for workspace (graph) settings.
 */
import { useQuery } from '@tanstack/react-query';
import { getWorkspaceSettings } from '../api/workspaces';
import { workspaceSettingsKeys } from '@/hooks/queryKeys';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';

export function useWorkspaceSettings() {
  const workspaceUuid = useCurrentWorkspaceUuid();

  return useQuery({
    queryKey: workspaceSettingsKeys.detail(workspaceUuid ?? 'none'),
    queryFn: () => getWorkspaceSettings(workspaceUuid!),
    enabled: !!workspaceUuid,
    staleTime: 1000 * 60 * 5,
  });
}
