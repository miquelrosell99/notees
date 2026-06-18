import { useMemo, useCallback } from 'react';
import { getOperationRuntime } from '@/runtime';
import { getNode } from '@/runtime/graphHelpers';
import { useSetNodeProperty, useProperties } from '@/features/properties';
import {
  SYSTEM_PROPERTY_UUIDS,
  TASK_STATUSES,
  TASK_STATUS_CYCLE,
} from '@/constants/systemProperties';
import { queryClient } from '@/lib/queryClient';
import { propertyKeys } from '@/hooks/queryKeys';
import type { Node } from '@/types/api';

/**
 * All known task statuses (matches backend TASK_STATUS_OPTIONS).
 */
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Check if a node is a task by looking at the runtime graph node.
 */
function isTaskNode(node: Node | undefined): boolean {
  if (!node) return false;
  const runtime = getOperationRuntime();
  const gn = getNode(runtime, node.uuid);
  if (!gn) return false;
  return gn.taskStatus != null;
}

/**
 * Get the current task status for a node from the runtime.
 */
function getTaskStatus(node: Node | undefined): TaskStatus | null {
  if (!node) return null;
  const runtime = getOperationRuntime();
  const gn = getNode(runtime, node.uuid);
  if (!gn) return null;
  const status = gn.taskStatus;
  if (!status) return null;
  return TASK_STATUSES.includes(status as TaskStatus) ? (status as TaskStatus) : null;
}

/**
 * Cycle to the next task status.
 *
 * Only the statuses in TASK_STATUS_CYCLE participate in the cycle. Cancelled
 * is excluded as a terminal state; cycling from Cancelled (or any unknown
 * status) restarts at the beginning of the cycle.
 */
function nextStatus(current: TaskStatus | null): TaskStatus {
  if (!current) return 'Pending';
  const idx = TASK_STATUS_CYCLE.indexOf(current as (typeof TASK_STATUS_CYCLE)[number]);
  if (idx === -1) return TASK_STATUS_CYCLE[0];
  if (idx === TASK_STATUS_CYCLE.length - 1) return TASK_STATUS_CYCLE[0];
  return TASK_STATUS_CYCLE[idx + 1];
}

/**
 * Resolve the numeric property ID and option ID for a given task status name.
 * Looks up from the TanStack Query property cache.
 */
function resolveTaskStatusIds(
  statusName: TaskStatus
): { propertyId: number; optionId: number } | null {
  const allProperties = queryClient.getQueryData<
    { id: number; uuid: string; options?: { id: number; name: string }[] }[]
  >(propertyKeys.lists());
  const statusProp = allProperties?.find(
    (p) => p.uuid === SYSTEM_PROPERTY_UUIDS.task_status
  );
  if (!statusProp) return null;
  const option = statusProp.options?.find((o) => o.name === statusName);
  if (!option) return null;
  return { propertyId: statusProp.id, optionId: option.id };
}

/**
 * Hook providing task-related actions and state for a block row.
 *
 * Reads task status from the runtime projection and dispatches
 * property mutations to the backend via the property API.
 */
export function useTaskActions(node: Node) {
  const isTask = useMemo(() => isTaskNode(node), [node]);
  const taskStatus = useMemo(() => getTaskStatus(node), [node]);

  // Ensure properties are cached so resolveTaskStatusIds works
  useProperties();

  const setProperty = useSetNodeProperty();

  const applyTaskStatus = useCallback(
    (status: TaskStatus) => {
      const ids = resolveTaskStatusIds(status);
      if (!ids) {
        console.warn('[useTaskActions] Could not resolve task status property IDs');
        return;
      }
      if (!node.id) {
        console.warn('[useTaskActions] Node has no serverId yet');
        return;
      }
      setProperty.mutate({
        nodeId: node.id,
        propertyId: ids.propertyId,
        value: ids.optionId,
      });
    },
    [node.id, setProperty]
  );

  const toggleTask = useCallback(() => {
    if (!isTask) {
      // Not yet a task — set status to Pending.
      applyTaskStatus('Pending');
      return;
    }
    const next = nextStatus(taskStatus ?? null);
    applyTaskStatus(next);
  }, [isTask, taskStatus, applyTaskStatus]);

  const cycleTaskStatus = useCallback(() => {
    if (!isTask) {
      // Turn into a task first.
      applyTaskStatus('Pending');
      return;
    }
    const next = nextStatus(taskStatus ?? null);
    applyTaskStatus(next);
  }, [isTask, taskStatus, applyTaskStatus]);

  return {
    isTask,
    taskStatus,
    toggleTask,
    cycleTaskStatus,
  };
}
