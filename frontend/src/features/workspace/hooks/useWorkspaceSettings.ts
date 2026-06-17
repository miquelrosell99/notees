/**
 * React Query hook for workspace (graph) settings.
 */
import { useQuery } from '@tanstack/react-query';
import { getWorkspaceSettings } from '../api/workspaces';
import { workspaceSettingsKeys } from '@/hooks/queryKeys';

export function useWorkspaceSettings() {
  return useQuery({
    queryKey: workspaceSettingsKeys.all,
    queryFn: getWorkspaceSettings,
    staleTime: 1000 * 60 * 5,
  });
}
