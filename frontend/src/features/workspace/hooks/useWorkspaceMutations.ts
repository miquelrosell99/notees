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
import { workspaceKeys } from '@/hooks/queryKeys';
import { useNavigationStore, useFavoritesStore, useRecentsStore } from '@/stores';

export function useWorkspaceMutations() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const switchWorkspaceMutation = useMutation({
    mutationFn: switchWorkspace,
    onMutate: () => {
      useNavigationStore.setState({ isSwitchingWorkspace: true });
    },
    onSuccess: (_data, switchedWorkspaceUuid) => {
      useNavigationStore.setState({
        currentNodeUuid: null,
        activeNodeUuid: null,
        sidebarNode: null,
        localGraphNodeUuid: null,
        mainViewType: 'node',
      });
      useFavoritesStore.getState().clearFavorites();
      useRecentsStore.getState().clearRecents();
      navigate(`/${switchedWorkspaceUuid}`, { replace: true });
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
    mutationFn: ({ workspaceUuid, file }: { workspaceUuid: string; file: File }) => restoreWorkspace(workspaceUuid, file),
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
