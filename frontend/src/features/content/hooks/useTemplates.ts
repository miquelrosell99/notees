/**
 * React Query hooks for the template system.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import type { TemplateInstantiateOptions } from '@/api/nodes';
import { templateKeys, nodeKeys } from '@/hooks/queryKeys';
import { getNodeUuidByServerId } from './useNodeMutations.utils';

export function useTemplates() {
  return useQuery({
    queryKey: templateKeys.list(),
    queryFn: () => nodesApi.listTemplates(),
    staleTime: 30_000,
  });
}

export function useTemplateVariables(nodeId: number | null) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: templateKeys.variables(nodeId!),
    queryFn: () => {
      const nodeUuid = getNodeUuidByServerId(queryClient, nodeId!);
      if (!nodeUuid) throw new Error('Node UUID not found');
      return nodesApi.getTemplateVariables(nodeUuid);
    },
    enabled: nodeId != null,
    staleTime: 60_000,
  });
}

export function useInstantiateTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, options }: { nodeId: number; options: TemplateInstantiateOptions }) => {
      const nodeUuid = getNodeUuidByServerId(queryClient, nodeId);
      if (!nodeUuid) throw new Error('Node UUID not found');
      return nodesApi.instantiateTemplate(nodeUuid, options);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.all });
    },
  });
}
