import { getOperationRuntime } from '@/runtime';
import { getNode } from '@/runtime/graphHelpers';
import { upsertNodes } from '@/runtime/eventBus';
import { queryClient } from '@/lib/queryClient';
import { propertyKeys, taskKeys } from '@/hooks/queryKeys';
import {
  SYSTEM_PROPERTY_UUIDS,
  TASK_CLOSED_STATUSES,
  TASK_POPUP_HIDDEN_STATUSES,
} from '@/constants/systemProperties';
import { compareDayUuids, dateToDayUuid, getTodayDayUuid, isDayUuid } from '@/utils/dateUuid';
import type { TASK_STATUSES } from '@/constants/systemProperties';
import type { QueryExecuteResponse } from '@/types/nodeView';
import type { Node } from '@/types/api';
import type { PopupSection } from './useTasksPopupData';

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

// ==================== Optimistic popup section updates ====================

const POPUP_SECTIONS: readonly PopupSection[] = [
  'overdue',
  'today',
  'upcoming',
  'unscheduled',
  'completed',
];

type PopupQuerySnapshot = [ReturnType<typeof taskKeys.popup>, QueryExecuteResponse | undefined];

/** Scheduled/deadline day UUIDs of a task node (empty when unscheduled). */
function taskPopupDates(node: Node): string[] {
  const props = node.properties_uuid as Record<string, unknown> | undefined;
  return [props?.[SYSTEM_PROPERTY_UUIDS.task_scheduled], props?.[SYSTEM_PROPERTY_UUIDS.task_deadline]]
    .filter((value): value is string => typeof value === 'string' && isDayUuid(value));
}

/** Which open popup section a task belongs to, mirroring the buildPopup* ASTs. */
function openPopupSectionForTask(node: Node): PopupSection | null {
  const dates = taskPopupDates(node);
  if (dates.length === 0) return 'unscheduled';
  const todayUuid = getTodayDayUuid();
  if (dates.some((d) => compareDayUuids(d, todayUuid) < 0)) return 'overdue';
  if (dates.some((d) => compareDayUuids(d, todayUuid) === 0)) return 'today';
  // buildPopupUpcomingQueryAST(7) matches dates before today + 7 + 1 days.
  const upcomingEnd = new Date();
  upcomingEnd.setDate(upcomingEnd.getDate() + 8);
  if (dates.some((d) => compareDayUuids(d, dateToDayUuid(upcomingEnd)) < 0)) return 'upcoming';
  return null; // Beyond the upcoming window — not listed in the popup.
}

/** Section a task lands in after a status change (null = leaves the popup). */
function targetPopupSection(node: Node, status: TaskStatus): PopupSection | null {
  if (TASK_CLOSED_STATUSES.has(status)) return status === 'Done' ? 'completed' : null;
  if (TASK_POPUP_HIDDEN_STATUSES.has(status)) return null;
  return openPopupSectionForTask(node);
}

function removeFromPopupSection(section: PopupSection, nodeUuid: string): Node | undefined {
  const key = taskKeys.popup(section);
  const data = queryClient.getQueryData<QueryExecuteResponse>(key);
  const node = data?.nodes.find((n) => n.uuid === nodeUuid);
  if (!data || !node) return undefined;
  queryClient.setQueryData<QueryExecuteResponse>(key, {
    ...data,
    nodes: data.nodes.filter((n) => n.uuid !== nodeUuid),
    total_count: data.total_count === undefined ? undefined : Math.max(0, data.total_count - 1),
  });
  return node;
}

function insertIntoPopupSection(section: PopupSection, node: Node): void {
  const key = taskKeys.popup(section);
  const data = queryClient.getQueryData<QueryExecuteResponse>(key);
  if (!data) return; // Section not loaded — nothing to patch.
  queryClient.setQueryData<QueryExecuteResponse>(key, {
    ...data,
    nodes: [node, ...data.nodes],
    total_count: data.total_count === undefined ? undefined : data.total_count + 1,
  });
}

/**
 * Optimistically move a task between the popup section queries after a status
 * change so the toggle feels instant even on slow connections: closed
 * statuses leave the open sections ('Done' lands in 'completed'), open
 * statuses leave 'completed' and re-enter the section matching their
 * scheduled/deadline date. Returns per-section snapshots for rollback.
 */
export function optimisticTaskStatusUpdate(
  nodeUuid: string,
  status: TaskStatus | null,
): PopupQuerySnapshot[] {
  // Don't let an in-flight section refetch overwrite the optimistic patch.
  void queryClient.cancelQueries({ queryKey: [...taskKeys.all, 'popup'] });

  const snapshots: PopupQuerySnapshot[] = [];
  let movedNode: Node | undefined;
  for (const section of POPUP_SECTIONS) {
    snapshots.push([
      taskKeys.popup(section),
      queryClient.getQueryData<QueryExecuteResponse>(taskKeys.popup(section)),
    ]);
    movedNode ??= removeFromPopupSection(section, nodeUuid);
  }
  if (movedNode && status !== null) {
    const target = targetPopupSection(movedNode, status);
    if (target) insertIntoPopupSection(target, movedNode);
  }
  return snapshots;
}

/** Restore popup section queries snapshotted by optimisticTaskStatusUpdate. */
export function rollbackTaskStatusUpdate(snapshots: PopupQuerySnapshot[]): void {
  for (const [key, data] of snapshots) {
    if (data !== undefined) queryClient.setQueryData(key, data);
  }
}
