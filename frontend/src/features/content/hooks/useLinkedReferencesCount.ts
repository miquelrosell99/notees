/**
 * Hook to get linked references count for section metadata.
 * Pass null or 0 to disable the queries (e.g. in compact/journal mode).
 */
import { useLinkedReferences, usePropertyBacklinks } from './useNodes';

export function useLinkedReferencesCount(nodeId: number | null) {
  const effectiveId = nodeId || null;
  const { data: refsData, isLoading: refsLoading } = useLinkedReferences(effectiveId);
  const { data: propertyBacklinks, isLoading: propLoading } = usePropertyBacklinks(effectiveId);
  
  const pageCount = propertyBacklinks?.length ?? 0;
  const blockCount = refsData?.total_count ?? 0;
  const totalCount = pageCount + blockCount;
  
  return {
    count: totalCount,
    isLoading: refsLoading || propLoading,
  };
}
