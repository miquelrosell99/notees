/**
 * React Query hook for graph/workspace settings.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getWorkspaceSettings, setWorkspaceSetting } from '../api/workspaces';
import { workspaceSettingsKeys } from '@/hooks/queryKeys';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';

export function useGraphSettings() {
  const queryClient = useQueryClient();
  const workspaceUuid = useCurrentWorkspaceUuid();

  const settingsQuery = useQuery({
    queryKey: workspaceSettingsKeys.detail(workspaceUuid ?? 'none'),
    queryFn: () => getWorkspaceSettings(workspaceUuid!),
    enabled: !!workspaceUuid,
    staleTime: 1000 * 60 * 5,
  });

  const updateSetting = useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) =>
      setWorkspaceSetting(workspaceUuid!, key, value),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workspaceSettingsKeys.detail(workspaceUuid ?? 'none') });
    },
  });

  return {
    ...settingsQuery,
    settings: settingsQuery.data,
    updateSetting,
  };
}
