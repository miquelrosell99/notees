import { getOperationRuntime } from '@/runtime';
import { getNode } from '@/runtime/graphHelpers';
import { upsertNodes } from '@/runtime/eventBus';
import { queryClient } from '@/lib/queryClient';
import { propertyKeys, taskKeys } from '@/hooks/queryKeys';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import type { TASK_STATUSES } from '@/constants/systemProperties';

/** All known task statuses (matches backend TASK_STATUS_OPTIONS). */
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Optimistically mirror a task-status change into the runtime so the status
 * badge (read from the runtime projection in BlockAfterContent) updates
 * immediately, without waiting for a server refetch.
 */
export function setRuntimeTaskStatus(nodeUuid: string, status: TaskStatus | null): void {
  const runtime = getOperationRuntime();
  const gn = getNode(runtime, nodeUuid);
  if (gn) upsertNodes([{ ...gn, taskStatus: status }]);
}

/**
 * Resolve the property UUID and option UUID for a given task status name.
 * Looks up from the TanStack Query property cache.
 */
export function resolveTaskStatusIds(
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

/** Invalidate all tasks-popup section queries (badge + list refresh). */
export function invalidateTaskPopupQueries(): void {
  queryClient.invalidateQueries({ queryKey: [...taskKeys.all, 'popup'] });
}
