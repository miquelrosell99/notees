/**
 * React Query mutation for persisting Gantt bar date changes.
 */
import { useMutation } from '@tanstack/react-query';
import { useSetNodePropertyAdapter } from '@/core/adapters/useSetNodePropertyAdapter';
import { getOrCreateDailyNote } from '@/features/content/hooks/useNodeDateQueries';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { getWorkspaceStore } from '@/core/adapters/workspaceStoreAdapter';
import { formatDateForApi } from '../renderers/GanttRenderer';
import type { Property } from '@/types/api';

export interface PersistGanttDatesInput {
  nodeUuid: string;
  mode: 'move' | 'resize-end';
  newStart: Date;
  newEnd: Date | null;
}

export function useGanttDateMutation(
  startDateProperty: Property | undefined,
  endDateProperty: Property | undefined,
  options?: {
    onMutate?: (input: PersistGanttDatesInput) => void;
    onSettled?: (nodeUuid: string) => void;
  }
) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const setProperty = useSetNodePropertyAdapter();

  return useMutation({
    mutationFn: async ({ nodeUuid, mode, newStart, newEnd }: PersistGanttDatesInput) => {
      if (!startDateProperty || !workspaceUuid) return;
      const store = getWorkspaceStore(workspaceUuid);
      if (!store) return;
      if (mode === 'move') {
        const startDayNode = getOrCreateDailyNote(store, formatDateForApi(newStart));
        await setProperty.mutateAsync({ nodeUuid, propertyId: startDateProperty.uuid, value: startDayNode.uuid });
      }
      if (newEnd && endDateProperty) {
        const endDayNode = getOrCreateDailyNote(store, formatDateForApi(newEnd));
        await setProperty.mutateAsync({ nodeUuid, propertyId: endDateProperty.uuid, value: endDayNode.uuid });
      }
    },
    onMutate: (input) => {
      options?.onMutate?.(input);
    },
    onSuccess: async (_, { nodeUuid }) => {
      options?.onSettled?.(nodeUuid);
    },
  });
}
