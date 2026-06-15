/**
 * Task recurrence and completion history API.
 *
 * These endpoints live alongside the legacy task properties and provide a
 * dedicated source of truth for recurring task rules and their history.
 */
import api from './client';
import type { RecurrenceRule, TaskCompletion, TaskCompletionInput } from '@/types/api';

export async function getRecurrenceRule(nodeId: number): Promise<RecurrenceRule | null> {
  const { data } = await api.get<RecurrenceRule | null>(`/tasks/${nodeId}/recurrence`);
  return data;
}

export async function setRecurrenceRule(
  nodeId: number,
  rule: Omit<RecurrenceRule, 'id' | 'uuid' | 'task_node_id' | 'create_date' | 'write_date' | 'description'>
): Promise<RecurrenceRule> {
  const { data } = await api.put<RecurrenceRule>(`/tasks/${nodeId}/recurrence`, rule);
  return data;
}

export async function deleteRecurrenceRule(nodeId: number): Promise<{ deleted: boolean }> {
  const { data } = await api.delete<{ deleted: boolean }>(`/tasks/${nodeId}/recurrence`);
  return data;
}

export async function listTaskCompletions(
  nodeId: number,
  options?: { limit?: number; offset?: number }
): Promise<TaskCompletion[]> {
  const { data } = await api.get<TaskCompletion[]>(`/tasks/${nodeId}/completions`, {
    params: {
      limit: options?.limit ?? 50,
      offset: options?.offset ?? 0,
    },
  });
  return data;
}

export async function recordTaskCompletion(
  nodeId: number,
  input: TaskCompletionInput
): Promise<TaskCompletion> {
  const { data } = await api.post<TaskCompletion>(`/tasks/${nodeId}/completions`, input);
  return data;
}

export async function deleteTaskCompletion(
  nodeId: number,
  completionId: number
): Promise<{ deleted: boolean }> {
  const { data } = await api.delete<{ deleted: boolean }>(
    `/tasks/${nodeId}/completions/${completionId}`
  );
  return data;
}
