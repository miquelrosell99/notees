/**
 * useNodesWithProperty
 */
import { useQuery } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import { propertyKeys } from '@/hooks/queryKeys';


export function useNodesWithProperty(propertyUuid: string | null) {
  return useQuery({
    queryKey: propertyKeys.nodes(propertyUuid ?? ''),
    queryFn: async () => {
      if (!propertyUuid) return [];
      const { getNodesWithProperty } = await import('@/api/properties');
      const response = await getNodesWithProperty(propertyUuid);

      return response.nodes.map(item => ({
        uuid: item.node_uuid,
        name: item.node_name,
        icon: item.node_icon,
        color: item.node_color,
        parent_uuid: item.parent_uuid,
        page_uuid: item.page_uuid,
        is_page: item.is_page,
        is_class: item.is_class,
        sequence: 0,
        collapsed: false,
        active: true,
        create_date: item.create_date,
        write_date: item.write_date,
        properties: item.properties,
        classes_uuid: item.class_uuids,
      } as unknown as Node));
    },
    enabled: !!propertyUuid,
    staleTime: 30000,
  });
}
