import { useCallback, useState } from 'react';
import * as nodesApi from '@/api/nodes';
import { useCreateNode } from '@/features/content';
import { useSetNodeProperty } from '@/features/properties';
import { useNotificationStore } from '@/stores/notificationStore';
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import { getTodayDayUuid } from '@/utils/dateUuid';
import { invalidateTaskPopupQueries } from './taskStatusShared';

/** Local ISO date (YYYY-MM-DD), matching the CalendarPopup wrapper's format. */
function toIsoLocal(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Quick-add a task from the popup: creates a task block on today's daily
 * journal page (Status=Pending comes from backend class-property defaults)
 * and schedules it for today so it lands in the popup's Today section.
 */
export function useQuickAddTask() {
  const [isAdding, setIsAdding] = useState(false);
  const createNode = useCreateNode();
  const setProperty = useSetNodeProperty();

  const quickAdd = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed || isAdding) return;
      setIsAdding(true);
      try {
        const daily = await nodesApi.getOrCreateDaily(toIsoLocal(new Date()));
        const node = await createNode.mutateAsync({
          name: trimmed,
          parent_uuid: daily.uuid,
          class_uuids: [SYSTEM_CLASS_UUIDS.task],
        });
        setProperty.mutate({
          nodeUuid: node.uuid,
          propertyId: SYSTEM_PROPERTY_UUIDS.task_scheduled,
          value: getTodayDayUuid(),
        });
        invalidateTaskPopupQueries();
      } catch (err) {
        useNotificationStore
          .getState()
          .error('Failed to add task', err instanceof Error ? err.message : undefined);
        throw err;
      } finally {
        setIsAdding(false);
      }
    },
    [createNode, setProperty, isAdding],
  );

  return { quickAdd, isAdding };
}
