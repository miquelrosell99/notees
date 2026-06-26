/**
 * React Query hooks for the template system.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import type { TemplateInstantiateOptions } from '@/api/nodes';
import { templateKeys, nodeKeys } from '@/hooks/queryKeys';

export function useTemplates() {
  return useQuery({
    queryKey: templateKeys.list(),
    queryFn: () => nodesApi.listTemplates(),
    staleTime: 30_000,
  });
}

export function useTemplateVariables(nodeUuid: string | null) {
  return useQuery({
    queryKey: templateKeys.variables(nodeUuid!),
    queryFn: () => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      return nodesApi.getTemplateVariables(nodeUuid);
    },
    enabled: nodeUuid != null,
    staleTime: 60_000,
  });
}

export function useInstantiateTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeUuid, options }: { nodeUuid: string; options: TemplateInstantiateOptions }) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      return nodesApi.instantiateTemplate(nodeUuid, options);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.all });
    },
  });
}
