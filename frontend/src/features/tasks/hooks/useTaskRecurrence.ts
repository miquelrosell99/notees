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
} from '@/api/tasks';
import { taskKeys } from '@/hooks/queryKeys';
import type { RecurrenceRule, RecurrenceRuleInput, TaskCompletionInput } from '@/types/api';

export function useTaskRecurrence(nodeId: number | null | undefined) {
  return useQuery({
    queryKey: taskKeys.recurrence(nodeId ?? 0),
    queryFn: () => getRecurrenceRule(nodeId!),
    enabled: !!nodeId,
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
      nodeId: number;
      rule: RecurrenceRuleInput;
    }): Promise<RecurrenceRule> => {
      return setRecurrenceRule(nodeId, rule);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: taskKeys.recurrence(variables.nodeId) });
    },
  });
}

export function useDeleteTaskRecurrence() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ nodeId }: { nodeId: number }) => deleteRecurrenceRule(nodeId),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: taskKeys.recurrence(variables.nodeId) });
    },
  });
}

export function useTaskCompletions(
  nodeId: number | null | undefined,
  options: { limit?: number; offset?: number } = {}
) {
  const { limit = 50, offset = 0 } = options;
  return useQuery({
    queryKey: taskKeys.completions(nodeId ?? 0, limit, offset),
    queryFn: () => listTaskCompletions(nodeId!, { limit, offset }),
    enabled: !!nodeId,
  });
}

export function useRecordTaskCompletion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      nodeId,
      input,
    }: {
      nodeId: number;
      input: TaskCompletionInput;
    }) => recordTaskCompletion(nodeId, input),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: taskKeys.completions(variables.nodeId),
      });
    },
  });
}

export function useDeleteTaskCompletion() {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: ({ nodeId, completionId }: { nodeId: number; completionId: number }) =>
      deleteTaskCompletion(nodeId, completionId),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: taskKeys.completions(variables.nodeId),
      });
    },
  });

  const deleteCompletion = useCallback(
    (nodeId: number, completionId: number) => {
      mutation.mutate({ nodeId, completionId });
    },
    [mutation]
  );

  return { ...mutation, deleteCompletion };
}
