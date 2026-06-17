/**
 * React Query mutations for workspace import/creation.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { importWorkspace as importWorkspaceApi, createWorkspace } from '../api/workspaces';
import { workspaceKeys } from '@/hooks/queryKeys';

export function useWorkspaceImport() {
  const queryClient = useQueryClient();

  const importWorkspace = useMutation({
    mutationFn: ({ name, file }: { name: string; file: File }) => importWorkspaceApi(name, file),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
    },
  });

  const createWorkspaceForImport = useMutation({
    mutationFn: (name: string) => createWorkspace(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
    },
  });

  return {
    importWorkspace,
    createWorkspace: createWorkspaceForImport,
  };
}
