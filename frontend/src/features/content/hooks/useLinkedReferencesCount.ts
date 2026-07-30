/**
 * Hook to get linked references count for section metadata.
 * Pass null or 0 to disable the queries (e.g. in compact/journal mode).
 */
import { GetBacklinksQuery } from '@/core/graphQueries/queries';
import { useGraphQuery } from '@/core/graphQueries/hooks/useGraphQuery';
import { usePropertyBacklinks } from './useNodeLinkQueries';

export function useLinkedReferencesCount(nodeUuid: string | null) {
  const effectiveId = nodeUuid || null;
  const backlinks = useGraphQuery(
    GetBacklinksQuery,
    { nodeUuid: effectiveId ?? '' },
    { enabled: !!effectiveId }
  );
  const { data: propertyBacklinks, isLoading: propLoading } = usePropertyBacklinks(effectiveId);

  const totalCount =
    (backlinks.data?.totalCount ?? 0) + (propertyBacklinks?.length ?? 0);

  return {
    count: totalCount,
    isLoading: backlinks.isLoading || propLoading,
  };
}
