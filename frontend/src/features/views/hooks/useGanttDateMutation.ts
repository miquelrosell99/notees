/**
 * React Query mutation for persisting Gantt bar date changes.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { setProperty, getOrCreateDaily } from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from '@/features/content';
import { resolveNodeUuid } from '@/utils/resolveNodeUuid';
import { formatDateForApi } from '../renderers/GanttRenderer';
import type { Property } from '@/types/api';

export interface PersistGanttDatesInput {
  nodeId: string | number;
  mode: 'move' | 'resize-end';
  newStart: Date;
  newEnd: Date | null;
}

export function useGanttDateMutation(
  startDateProperty: Property | undefined,
  endDateProperty: Property | undefined,
  options?: {
    onMutate?: (input: PersistGanttDatesInput) => void;
    onSettled?: (nodeId: string | number) => void;
  }
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ nodeId, mode, newStart, newEnd }: PersistGanttDatesInput) => {
      if (!startDateProperty) return;
      const nodeUuid = resolveNodeUuid(nodeId);
      if (mode === 'move') {
        const startDayNode = await getOrCreateDaily(formatDateForApi(newStart));
        await setProperty(nodeUuid, startDateProperty.uuid, startDayNode.uuid);
      }
      if (newEnd && endDateProperty) {
        const endDayNode = await getOrCreateDaily(formatDateForApi(newEnd));
        await setProperty(nodeUuid, endDateProperty.uuid, endDayNode.uuid);
      }
    },
    onMutate: (input) => {
      options?.onMutate?.(input);
    },
    onSuccess: async (_, { nodeId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeId) }),
        queryClient.invalidateQueries({ queryKey: nodeKeys.ganttDayNodes([]) }),
        queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() }),
      ]);
      options?.onSettled?.(nodeId);
    },
  });
}
