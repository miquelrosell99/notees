import { useCallback } from 'react';
import { useSetNodeProperty, useProperties } from '@/features/properties';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import {
  setRuntimeTaskStatus,
  resolveTaskStatusIds,
  invalidateTaskPopupQueries,
  type TaskStatus,
} from './taskStatusShared';

/**
 * Set or clear the task status of any node by uuid.
 * Mirrors the change optimistically into the runtime (badge updates instantly)
 * and invalidates the tasks popup queries once the mutation settles.
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
        setProperty.mutate(
          { nodeUuid, propertyId: SYSTEM_PROPERTY_UUIDS.task_status, value: null },
          { onSettled: invalidateTaskPopupQueries },
        );
        setRuntimeTaskStatus(nodeUuid, null);
        return;
      }
      const ids = resolveTaskStatusIds(status);
      if (!ids) {
        console.warn('[useSetTaskStatus] Could not resolve task status property IDs');
        return;
      }
      setProperty.mutate(
        { nodeUuid, propertyId: ids.propertyId, value: ids.optionId },
        { onSettled: invalidateTaskPopupQueries },
      );
      setRuntimeTaskStatus(nodeUuid, status);
    },
    [setProperty],
  );
}
