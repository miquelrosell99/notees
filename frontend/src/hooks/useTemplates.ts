/**
 * React Query hooks for the template system.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import type { TemplateInstantiateOptions } from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';


export const templateKeys = {
  all: ['templates'] as const,
  list: () => [...templateKeys.all, 'list'] as const,
  variables: (nodeId: number) => [...templateKeys.all, 'variables', nodeId] as const,
};

export function useTemplates() {
  return useQuery({
    queryKey: templateKeys.list(),
    queryFn: () => nodesApi.listTemplates(),
    staleTime: 30_000,
  });
}

export function useTemplateVariables(nodeId: number | null) {
  return useQuery({
    queryKey: templateKeys.variables(nodeId!),
    queryFn: () => nodesApi.getTemplateVariables(nodeId!),
    enabled: nodeId != null,
    staleTime: 60_000,
  });
}

export function useInstantiateTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, options }: { nodeId: number; options: TemplateInstantiateOptions }) =>
      nodesApi.instantiateTemplate(nodeId, options),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.all });
    },
  });
}
