/**
 * React Query mutation for persisting Gantt bar date changes.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { setProperty } from '@/api/nodes';
import { getOrCreateDailyNote } from '@/features/content/hooks/useNodeDateQueries';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from '@/features/content';
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
  const queryClient = useQueryClient();
  const workspaceUuid = useCurrentWorkspaceUuid();

  return useMutation({
    mutationFn: async ({ nodeUuid, mode, newStart, newEnd }: PersistGanttDatesInput) => {
      if (!startDateProperty || !workspaceUuid) return;
      const store = getWorkspaceStore(workspaceUuid);
      if (!store) return;
      if (mode === 'move') {
        const startDayNode = getOrCreateDailyNote(store, formatDateForApi(newStart));
        await setProperty(nodeUuid, startDateProperty.uuid, startDayNode.uuid);
      }
      if (newEnd && endDateProperty) {
        const endDayNode = getOrCreateDailyNote(store, formatDateForApi(newEnd));
        await setProperty(nodeUuid, endDateProperty.uuid, endDayNode.uuid);
      }
    },
    onMutate: (input) => {
      options?.onMutate?.(input);
    },
    onSuccess: async (_, { nodeUuid }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeUuid) }),
        queryClient.invalidateQueries({ queryKey: nodeKeys.ganttDayNodes([]) }),
        queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() }),
      ]);
      options?.onSettled?.(nodeUuid);
    },
  });
}
