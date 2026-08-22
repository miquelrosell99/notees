/**
 * React Query hook for workspace (graph) settings.
 */
import { useQuery } from '@tanstack/react-query';
import { getWorkspaceSettings } from '../api/workspaces';
import { workspaceSettingsKeys } from '@/hooks/queryKeys';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useCapabilities } from '@/config/capabilities';

export function useWorkspaceSettings() {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const capabilities = useCapabilities();

  return useQuery({
    queryKey: workspaceSettingsKeys.detail(workspaceUuid ?? 'none'),
    queryFn: () => getWorkspaceSettings(workspaceUuid!),
    // Server-side settings don't exist in local mode (local-first split).
    enabled: !!workspaceUuid && capabilities.workspaceManagement,
    staleTime: 1000 * 60 * 5,
  });
}
