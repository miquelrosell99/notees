import { useMemo, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { useNode } from '@/core/hooks/useNode';
import { useProperty } from '@/core/hooks/useProperty';
import { useSetNodeProperty, useProperties } from '@/features/properties';
import { useAddClass, useRemoveClass } from '@/features/content';
import {
  SYSTEM_PROPERTY_UUIDS,
  SYSTEM_CLASS_UUIDS,
  TASK_CLOSED_STATUSES,
} from '@/constants/systemProperties';
import { resolveTaskStatusIds, resolveTaskStatusName } from './taskStatusShared';
import type { TaskStatus } from './taskStatusShared';
import type { Node } from '@/types/api';

export type { TaskStatus } from './taskStatusShared';

/**
 * Hook providing task-related actions and state for a block row.
 *
 * Reads task membership and status from the local-first core store (SQLite
 * derived view) and dispatches property and class mutations through the
 * canonical core paths.
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
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { node: nodeRow } = useNode(workspaceId ?? '', node.uuid);
  const { value: statusOptionUuid } = useProperty({
    nodeId: node.uuid,
    schemaId: SYSTEM_PROPERTY_UUIDS.task_status,
  });

  const isTask = useMemo(
    () => nodeRow?.classIds.includes(SYSTEM_CLASS_UUIDS.task) ?? false,
    [nodeRow]
  );

  const taskStatus = useMemo(() => {
    if (typeof statusOptionUuid !== 'string') return null;
    return resolveTaskStatusName(statusOptionUuid);
  }, [statusOptionUuid]);

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
    if (taskStatus != null && TASK_CLOSED_STATUSES.has(taskStatus)) {
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
