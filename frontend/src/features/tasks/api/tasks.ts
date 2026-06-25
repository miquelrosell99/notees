/**
 * Task recurrence and completion history API.
 *
 * These endpoints live alongside the legacy task properties and provide a
 * dedicated source of truth for recurring task rules and their history.
 */
import api from '@/api/client';
import type { RecurrenceRule, TaskCompletion, TaskCompletionInput } from '@/types/api';

export async function getRecurrenceRule(nodeUuid: string): Promise<RecurrenceRule | null> {
  const { data } = await api.get<RecurrenceRule | null>(`/tasks/${nodeUuid}/recurrence`);
  return data;
}

export async function setRecurrenceRule(
  nodeUuid: string,
  rule: Omit<RecurrenceRule, 'id' | 'uuid' | 'task_node_id' | 'task_node_uuid' | 'create_date' | 'write_date' | 'description'>
): Promise<RecurrenceRule> {
  const { data } = await api.put<RecurrenceRule>(`/tasks/${nodeUuid}/recurrence`, rule);
  return data;
}

export async function deleteRecurrenceRule(nodeUuid: string): Promise<{ deleted: boolean }> {
  const { data } = await api.delete<{ deleted: boolean }>(`/tasks/${nodeUuid}/recurrence`);
  return data;
}

export async function listTaskCompletions(
  nodeUuid: string,
  options?: { limit?: number; offset?: number }
): Promise<TaskCompletion[]> {
  const { data } = await api.get<TaskCompletion[]>(`/tasks/${nodeUuid}/completions`, {
    params: {
      limit: options?.limit ?? 50,
      offset: options?.offset ?? 0,
    },
  });
  return data;
}

export async function recordTaskCompletion(
  nodeUuid: string,
  input: TaskCompletionInput
): Promise<TaskCompletion> {
  const { data } = await api.post<TaskCompletion>(`/tasks/${nodeUuid}/completions`, input);
  return data;
}

export async function deleteTaskCompletion(
  nodeUuid: string,
  completionUuid: string
): Promise<{ deleted: boolean }> {
  const { data } = await api.delete<{ deleted: boolean }>(
    `/tasks/${nodeUuid}/completions/${completionUuid}`
  );
  return data;
}
