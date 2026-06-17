/**
 * Recent pages server state via TanStack Query.
 *
 * Provides a query hook for components and an imperative helper for
 * non-component code that needs to drop a node from the cached list.
 */
import { useQuery } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { queryClient } from '@/lib/queryClient';
import { recentKeys } from '@/hooks/queryKeys';

export interface RecentItem {
  nodeId: number;
  openDate: string;
}

export function useRecents(limit = 10) {
  return useQuery<RecentItem[], Error>({
    queryKey: recentKeys.list(limit),
    queryFn: async () => {
      const pages = await nodesApi.getRecentPages(limit);
      return pages.map((page) => ({ nodeId: page.id, openDate: page.open_date }));
    },
  });
}

export function removeRecent(nodeId: number): void {
  queryClient.setQueriesData<RecentItem[]>({ queryKey: recentKeys.all }, (prev) =>
    prev?.filter((item) => item.nodeId !== nodeId)
  );
}
