/**
 * React Query mutation for persisting Gantt bar date changes.
 */
import { useMutation } from '@tanstack/react-query';
import { useSetNodePropertyAdapter } from '@/core/adapters/useSetNodePropertyAdapter';
import { getOrCreateDailyNoteClient } from '@/features/content/hooks/useNodeDateQueries';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { getWorkspaceStoreClient } from '@/core/adapters/workspaceStoreClientAdapter';
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
      const client = getWorkspaceStoreClient(workspaceUuid);
      if (!client) return;
      if (mode === 'move') {
        const startDayNode = await getOrCreateDailyNoteClient(client, formatDateForApi(newStart));
        await setProperty.mutateAsync({ nodeUuid, propertyId: startDateProperty.uuid, value: startDayNode.uuid });
      }
      if (newEnd && endDateProperty) {
        const endDayNode = await getOrCreateDailyNoteClient(client, formatDateForApi(newEnd));
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
