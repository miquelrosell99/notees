import { useMemo, useCallback } from 'react';
import { getOperationRuntime } from '@/runtime';
import { getNode } from '@/runtime/graphHelpers';
import { useSetNodeProperty, useProperties } from '@/features/properties';
import { useAddClass, useRemoveClass } from '@/features/content';
import {
  SYSTEM_PROPERTY_UUIDS,
  SYSTEM_CLASS_UUIDS,
  TASK_STATUSES,
  TASK_CLOSED_STATUSES,
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
 * Resolve the numeric property ID and option ID for a given task status name.
 * Looks up from the TanStack Query property cache.
 */
function resolveTaskStatusIds(
  statusName: TaskStatus
): { propertyId: string; optionId: string } | null {
  const allProperties = queryClient.getQueryData<
    { uuid: string; options?: { uuid: string; name: string }[] }[]
  >(propertyKeys.lists());
  const statusProp = allProperties?.find(
    (p) => p.uuid === SYSTEM_PROPERTY_UUIDS.task_status
  );
  if (!statusProp) return null;
  const option = statusProp.options?.find((o) => o.name === statusName);
  if (!option) return null;
  return { propertyId: statusProp.uuid, optionId: option.uuid };
}

/**
 * Hook providing task-related actions and state for a block row.
 *
 * Reads task status from the runtime projection and dispatches property and
 * class mutations to the backend via the canonical optimistic/runtime paths.
 *
 * `cycleTaskStatus` (bound to Ctrl/Cmd+Enter in `BlockRow`) implements a
 * Roam/Logseq-style three-state toggle:
 *
 *   not a task  ->  TODO (Pending)  ->  DONE (Done)  ->  not a task
 *
 * It keeps the task *class* (which drives the backend `is_task` flag) and the
 * `task_status` *property* (which drives the editor badge) in sync on every
 * transition, mirroring the `/task` slash command. A block is never left with a
 * status but no class, or a class but no status.
 */
export function useTaskActions(node: Node) {
  const isTask = useMemo(() => isTaskNode(node), [node]);
  const taskStatus = useMemo(() => getTaskStatus(node), [node]);

  // Ensure properties are cached so resolveTaskStatusIds works
  useProperties();

  const setProperty = useSetNodeProperty();
  const addClass = useAddClass();
  const removeClass = useRemoveClass();

  const applyTaskStatus = useCallback(
    (status: TaskStatus) => {
      const ids = resolveTaskStatusIds(status);
      if (!ids) {
        console.warn('[useTaskActions] Could not resolve task status property IDs');
        return;
      }
      if (!node.uuid) {
        console.warn('[useTaskActions] Node has no UUID yet');
        return;
      }
      setProperty.mutate({
        nodeUuid: node.uuid,
        propertyId: ids.propertyId,
        value: ids.optionId,
      });
    },
    [node.uuid, setProperty]
  );

  // none -> TODO: assign the task class (flips is_task) and set Pending.
  const openTask = useCallback(() => {
    if (!node.uuid) {
      console.warn('[useTaskActions] Node has no UUID yet');
      return;
    }
    addClass.mutate({ nodeUuid: node.uuid, classId: SYSTEM_CLASS_UUIDS.task });
    applyTaskStatus('Pending');
  }, [node.uuid, addClass, applyTaskStatus]);

  // DONE -> none: clear the status property and drop the task class.
  const clearTask = useCallback(() => {
    if (!node.uuid) {
      console.warn('[useTaskActions] Node has no UUID yet');
      return;
    }
    setProperty.mutate({
      nodeUuid: node.uuid,
      propertyId: SYSTEM_PROPERTY_UUIDS.task_status,
      value: null,
    });
    removeClass.mutate({ nodeUuid: node.uuid, classId: SYSTEM_CLASS_UUIDS.task });
  }, [node.uuid, setProperty, removeClass]);

  const cycleTaskStatus = useCallback(() => {
    if (!isTask) {
      openTask();
      return;
    }
    const closed = taskStatus != null && TASK_CLOSED_STATUSES.has(taskStatus);
    if (closed) {
      clearTask();
    } else {
      applyTaskStatus('Done');
    }
  }, [isTask, taskStatus, openTask, clearTask, applyTaskStatus]);

  // Public alias: both entry points share the same three-state toggle.
  const toggleTask = cycleTaskStatus;

  return {
    isTask,
    taskStatus,
    toggleTask,
    cycleTaskStatus,
  };
}
