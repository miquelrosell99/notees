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
import { useConnectionMode } from '@/stores/connectionStore';
import type { RecurrenceRule, RecurrenceRuleInput, TaskCompletionInput } from '@/types/api';

/**
 * Recurrence endpoints live on the server and have no dedicated capability
 * key, so these hooks read the connection mode directly (documented exception
 * to the useCapabilities-only rule — local-first split, Task 4).
 */
function useRecurrenceAvailable(): boolean {
  return useConnectionMode() !== 'local';
}

export function useTaskRecurrence(nodeUuid: string | null | undefined) {
  const resolvedUuid = nodeUuid ?? null;
  const available = useRecurrenceAvailable();
  return useQuery({
    queryKey: taskKeys.recurrence(resolvedUuid ?? ''),
    queryFn: () => getRecurrenceRule(resolvedUuid!),
    enabled: !!resolvedUuid && available,
    staleTime: 0,
  });
}

export function useSetTaskRecurrence() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
              nodeUuid,
              rule }: {
      nodeUuid: string;
      rule: RecurrenceRuleInput;
    }): Promise<RecurrenceRule> => {
      return setRecurrenceRule(nodeUuid, rule);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: taskKeys.recurrence(variables.nodeUuid) });
    },
  });
}

export function useDeleteTaskRecurrence() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ nodeUuid }: { nodeUuid: string }) => {
      return deleteRecurrenceRule(nodeUuid);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: taskKeys.recurrence(variables.nodeUuid) });
    },
  });
}

export function useTaskCompletions(
  nodeUuid: string | null | undefined,
  options: { limit?: number; offset?: number } = {}
) {
  const resolvedUuid = nodeUuid ?? null;
  const available = useRecurrenceAvailable();
  const { limit = 50, offset = 0 } = options;
  return useQuery({
    queryKey: taskKeys.completions(resolvedUuid ?? '', limit, offset),
    queryFn: () => listTaskCompletions(resolvedUuid!, { limit, offset }),
    enabled: !!resolvedUuid && available,
  });
}

export function useRecordTaskCompletion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
              nodeUuid,
              input }: {
      nodeUuid: string;
      input: TaskCompletionInput;
    }) => {
      return recordTaskCompletion(nodeUuid, input);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: taskKeys.completions(variables.nodeUuid),
      });
    },
  });
}

export function useDeleteTaskCompletion() {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: ({ nodeUuid, completionId }: { nodeUuid: string; completionId: string }) =>
      deleteTaskCompletion(nodeUuid, completionId),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: taskKeys.completions(variables.nodeUuid),
      });
    },
  });

  const deleteCompletion = useCallback(
    (nodeUuid: string, completionId: string) => {
      mutation.mutate({ nodeUuid, completionId });
    },
    [mutation]
  );

  return { ...mutation, deleteCompletion };
}
