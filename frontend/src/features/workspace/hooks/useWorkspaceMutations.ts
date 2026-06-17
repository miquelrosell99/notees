/**
 * React Query mutations for workspace management.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  switchWorkspace,
  deleteWorkspace,
  renameWorkspace,
  restoreWorkspace,
} from '../api/workspaces';
import { workspaceKeys, favoriteKeys, recentKeys } from '@/hooks/queryKeys';
import { useNavigationStore } from '@/stores';

export function useWorkspaceMutations() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const switchWorkspaceMutation = useMutation({
    mutationFn: switchWorkspace,
    onMutate: () => {
      useNavigationStore.setState({ isSwitchingWorkspace: true });
    },
    onSuccess: (_data, switchedUuid) => {
      useNavigationStore.setState({
        currentNodeId: null,
        activeNodeId: null,
        sidebarNode: null,
        localGraphNodeId: null,
        mainViewType: 'node',
      });
      queryClient.removeQueries({ queryKey: favoriteKeys.all });
      queryClient.removeQueries({ queryKey: recentKeys.all });
      navigate(`/${switchedUuid}`, { replace: true });
      queryClient.clear();
      useNavigationStore.setState({ isSwitchingWorkspace: false });
    },
    onError: () => {
      useNavigationStore.setState({ isSwitchingWorkspace: false });
    },
  });

  const deleteWorkspaceMutation = useMutation({
    mutationFn: deleteWorkspace,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
    },
  });

  const renameWorkspaceMutation = useMutation({
    mutationFn: ({ oldName, newName }: { oldName: string; newName: string }) =>
      renameWorkspace(oldName, newName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
    },
  });

  const restoreWorkspaceMutation = useMutation({
    mutationFn: ({ uuid, file }: { uuid: string; file: File }) => restoreWorkspace(uuid, file),
    onSuccess: () => {
      queryClient.clear();
    },
  });

  return {
    switchWorkspace: switchWorkspaceMutation,
    deleteWorkspace: deleteWorkspaceMutation,
    renameWorkspace: renameWorkspaceMutation,
    restoreWorkspace: restoreWorkspaceMutation,
  };
}
