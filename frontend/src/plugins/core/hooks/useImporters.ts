import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { pluginKeys } from '@/hooks/queryKeys';
import { listImporters, runImporter, type ImporterRunResult } from '../api';

export function useImporters(enabled = true) {
  return useQuery({
    queryKey: pluginKeys.importers(),
    queryFn: listImporters,
    enabled,
  });
}

export function useRunImporter() {
  const queryClient = useQueryClient();

  return useMutation<ImporterRunResult, Error, { importerId: string; file: File; workspaceUuid: string }>({
    mutationFn: ({ importerId, file, workspaceUuid }) => runImporter(importerId, file, workspaceUuid),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: pluginKeys.importers() });
    },
  });
}
