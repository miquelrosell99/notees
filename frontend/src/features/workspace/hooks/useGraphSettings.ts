/**
 * React Query hook for graph/workspace settings.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getWorkspaceSettings, setWorkspaceSetting } from '../api/workspaces';
import { workspaceSettingsKeys } from '@/hooks/queryKeys';

export function useGraphSettings() {
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: workspaceSettingsKeys.all,
    queryFn: getWorkspaceSettings,
    staleTime: 1000 * 60 * 5,
  });

  const updateSetting = useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) => setWorkspaceSetting(key, value),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workspaceSettingsKeys.all });
    },
  });

  return {
    ...settingsQuery,
    settings: settingsQuery.data,
    updateSetting,
  };
}
