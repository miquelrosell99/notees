/**
 * React Query mutation for persisting calendar event date changes.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { setProperty, getOrCreateDaily } from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from '@/features/content';
import type { Property } from '@/types/api';

function formatDateForApi(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function useCalendarDateMutation(startDateProperty: Property | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ nodeUuid, newDate }: { nodeUuid: string; newDate: Date }) => {
      if (!startDateProperty) return;
      const dayNode = await getOrCreateDaily(formatDateForApi(newDate));
      await setProperty(nodeUuid, startDateProperty.uuid, dayNode.uuid);
    },
    onSuccess: async (_, { nodeUuid }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeUuid) }),
        queryClient.invalidateQueries({ queryKey: nodeKeys.ganttDayNodes([]) }),
        queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() }),
      ]);
    },
  });
}
