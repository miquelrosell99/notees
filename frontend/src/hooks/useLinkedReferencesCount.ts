/**
 * Hook to get linked references count for section metadata
 */
import { useLinkedReferences, usePropertyBacklinks } from '@/hooks';

export function useLinkedReferencesCount(nodeId: number) {
  const { data: refs, isLoading: refsLoading } = useLinkedReferences(nodeId);
  const { data: propertyBacklinks, isLoading: propLoading } = usePropertyBacklinks(nodeId);
  
  const pageCount = propertyBacklinks?.length ?? 0;
  const blockCount = refs?.length ?? 0;
  const totalCount = pageCount + blockCount;
  
  return {
    count: totalCount,
    isLoading: refsLoading || propLoading,
  };
}
