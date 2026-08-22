/**
 * React Query mutation for persisting calendar event date changes.
 */
import { useMutation } from '@tanstack/react-query';
import { useSetNodePropertyAdapter } from '@/core/adapters/useSetNodePropertyAdapter';
import { getOrCreateDailyNoteClient } from '@/features/content';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { getWorkspaceStoreClient } from '@/core/adapters/workspaceStoreClientAdapter';
import type { Property } from '@/types/api';

function formatDateForApi(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function useCalendarDateMutation(startDateProperty: Property | undefined) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const setProperty = useSetNodePropertyAdapter();

  return useMutation({
    mutationFn: async ({ nodeUuid, newDate }: { nodeUuid: string; newDate: Date }) => {
      if (!startDateProperty || !workspaceUuid) return;
      const client = getWorkspaceStoreClient(workspaceUuid);
      if (!client) return;
      const dayNode = await getOrCreateDailyNoteClient(client, formatDateForApi(newDate));
      await setProperty.mutateAsync({ nodeUuid, propertyId: startDateProperty.uuid, value: dayNode.uuid });
    },
  });
}
