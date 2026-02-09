/**
 * Hook to fetch inline classes for a node
 * 
 * Inline classes are those defined in content like {{ClassId}}.
 * They're stored in node_link with is_inline_class=TRUE.
 */
import { useQuery } from '@tanstack/react-query';
import api from '@/api/client';

interface InlineClass {
  class_node_id: number;
  class_node_name: string;
  class_node_icon: string | null;
  position: number;
}

interface InlineClassesResponse {
  inline_classes: InlineClass[];
}

/**
 * Fetch inline classes for a node
 */
export function useInlineClasses(nodeId: number | null) {
  return useQuery({
    queryKey: ['inlineClasses', nodeId],
    queryFn: async () => {
      if (!nodeId) return { inline_classes: [] };
      
      const response = await api.get<InlineClassesResponse>(
        `/api/nodes/${nodeId}/inline-classes`
      );
      return response.data;
    },
    enabled: nodeId !== null,
    staleTime: 0, // Always refetch to ensure pills hide immediately
  });
}

/**
 * Get just the inline class IDs as a Set for easy lookup
 */
export function useInlineClassIds(nodeId: number | null): Set<number> {
  const { data } = useInlineClasses(nodeId);
  
  if (!data?.inline_classes) {
    return new Set();
  }
  
  return new Set(data.inline_classes.map((ic: InlineClass) => ic.class_node_id));
}
