/**
 * useNodesWithProperty
 */
import { useQuery } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import { propertyKeys } from '@/hooks/queryKeys';
import { resolvePropertyUuid } from '@/utils/resolveNodeUuid';

export function useNodesWithProperty(propertyId: string | number | null) {
  const propertyUuid = propertyId == null ? null : typeof propertyId === 'string' ? propertyId : resolvePropertyUuid(propertyId);
  return useQuery({
    queryKey: propertyKeys.nodes(propertyUuid ?? ''),
    queryFn: async () => {
      if (!propertyUuid) return [];
      const { getNodesWithProperty } = await import('@/api/properties');
      const response = await getNodesWithProperty(propertyUuid);

      return response.nodes.map(item => ({
        id: item.node_id,
        uuid: item.node_uuid,
        name: item.node_name,
        icon: item.node_icon,
        color: item.node_color,
        parent_id: item.parent_id,
        page_id: item.page_id,
        is_page: item.is_page,
        is_class: item.is_class,
        sequence: 0,
        collapsed: false,
        active: true,
        create_date: item.create_date,
        write_date: item.write_date,
        properties: item.properties,
        classes: item.class_ids,
      } as Node));
    },
    enabled: !!propertyId,
    staleTime: 30000,
  });
}
