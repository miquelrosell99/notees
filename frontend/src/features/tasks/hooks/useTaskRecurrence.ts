/**
 * React Query hooks for task recurrence rules and completion history.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import {
  deleteRecurrenceRule,
  deleteTaskCompletion,
  getRecurrenceRule,
  listTaskCompletions,
  recordTaskCompletion,
  setRecurrenceRule,
} from '@/features/tasks';
import { taskKeys } from '@/hooks/queryKeys';
import type { RecurrenceRule, RecurrenceRuleInput, TaskCompletionInput } from '@/types/api';

export function useTaskRecurrence(nodeId: string | number | null | undefined) {
  const nodeUuid = typeof nodeId === 'string' ? nodeId : nodeId != null ? String(nodeId) : '';
  return useQuery({
    queryKey: taskKeys.recurrence(nodeUuid),
    queryFn: () => getRecurrenceRule(nodeUuid),
    enabled: !!nodeUuid,
    staleTime: 0,
  });
}

export function useSetTaskRecurrence() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      nodeId,
      rule,
    }: {
      nodeId: string | number;
      rule: RecurrenceRuleInput;
    }): Promise<RecurrenceRule> => {
      const nodeUuid = typeof nodeId === 'string' ? nodeId : String(nodeId);
      return setRecurrenceRule(nodeUuid, rule);
    },
    onSuccess: (_data, variables) => {
      const nodeUuid = typeof variables.nodeId === 'string' ? variables.nodeId : String(variables.nodeId);
      queryClient.invalidateQueries({ queryKey: taskKeys.recurrence(nodeUuid) });
    },
  });
}

export function useDeleteTaskRecurrence() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ nodeId }: { nodeId: string | number }) => {
      const nodeUuid = typeof nodeId === 'string' ? nodeId : String(nodeId);
      return deleteRecurrenceRule(nodeUuid);
    },
    onSuccess: (_data, variables) => {
      const nodeUuid = typeof variables.nodeId === 'string' ? variables.nodeId : String(variables.nodeId);
      queryClient.invalidateQueries({ queryKey: taskKeys.recurrence(nodeUuid) });
    },
  });
}

export function useTaskCompletions(
  nodeId: string | number | null | undefined,
  options: { limit?: number; offset?: number } = {}
) {
  const { limit = 50, offset = 0 } = options;
  const nodeUuid = typeof nodeId === 'string' ? nodeId : nodeId != null ? String(nodeId) : '';
  return useQuery({
    queryKey: taskKeys.completions(nodeUuid, limit, offset),
    queryFn: () => listTaskCompletions(nodeUuid, { limit, offset }),
    enabled: !!nodeUuid,
  });
}

export function useRecordTaskCompletion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      nodeId,
      input,
    }: {
      nodeId: string | number;
      input: TaskCompletionInput;
    }) => {
      const nodeUuid = typeof nodeId === 'string' ? nodeId : String(nodeId);
      return recordTaskCompletion(nodeUuid, input);
    },
    onSuccess: (_data, variables) => {
      const nodeUuid = typeof variables.nodeId === 'string' ? variables.nodeId : String(variables.nodeId);
      queryClient.invalidateQueries({
        queryKey: taskKeys.completions(nodeUuid),
      });
    },
  });
}

export function useDeleteTaskCompletion() {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: ({ nodeId, completionId }: { nodeId: string | number; completionId: string }) =>
      deleteTaskCompletion(typeof nodeId === 'string' ? nodeId : String(nodeId), completionId),
    onSuccess: (_data, variables) => {
      const nodeUuid = typeof variables.nodeId === 'string' ? variables.nodeId : String(variables.nodeId);
      queryClient.invalidateQueries({
        queryKey: taskKeys.completions(nodeUuid),
      });
    },
  });

  const deleteCompletion = useCallback(
    (nodeId: string | number, completionId: string) => {
      mutation.mutate({ nodeId, completionId });
    },
    [mutation]
  );

  return { ...mutation, deleteCompletion };
}
