import { useCallback } from 'react';
import { useSetNodeProperty, useProperties } from '@/features/properties';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import {
  resolveTaskStatusIds,
  invalidateTaskPopupQueries,
  optimisticTaskStatusUpdate,
  rollbackTaskStatusUpdate,
  type TaskStatus,
} from './taskStatusShared';

/**
 * Set or clear the task status of any node by uuid.
 * Mirrors the change optimistically into the tasks popup section queries (the
 * row switches sections instantly), rolls the popup queries back on error, and
 * invalidates them once the mutation settles.
 */
export function useSetTaskStatus() {
  // Ensure properties are cached so resolveTaskStatusIds works
  useProperties();
  const setProperty = useSetNodeProperty();

  return useCallback(
    (nodeUuid: string, status: TaskStatus | null) => {
      if (!nodeUuid) {
        console.warn('[useSetTaskStatus] Node has no UUID yet');
        return;
      }
      if (status === null) {
        const snapshots = optimisticTaskStatusUpdate(nodeUuid, null);
        setProperty.mutate(
          { nodeUuid, propertyId: SYSTEM_PROPERTY_UUIDS.task_status, value: null },
          {
            onError: () => rollbackTaskStatusUpdate(snapshots),
            onSettled: invalidateTaskPopupQueries,
          },
        );
        return;
      }
      const ids = resolveTaskStatusIds(status);
      if (!ids) {
        console.warn('[useSetTaskStatus] Could not resolve task status property IDs');
        return;
      }
      const snapshots = optimisticTaskStatusUpdate(nodeUuid, status);
      setProperty.mutate(
        { nodeUuid, propertyId: ids.propertyId, value: ids.optionId },
        {
          onError: () => rollbackTaskStatusUpdate(snapshots),
          onSettled: invalidateTaskPopupQueries,
        },
      );
    },
    [setProperty],
  );
}
