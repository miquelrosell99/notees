/**
 * useNodeDateQueries
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from './queryKeys';
import type { Node, PaginatedResponse } from '@/types/api';
import { formatLocalDate } from './useNodeQueries.utils';

export function useExistingDailyPages() {
  return useQuery<PaginatedResponse<Node>, Error, Node[]>({
    queryKey: nodeKeys.dailyList(),
    queryFn: () => nodesApi.listDailyPages(),
    select: (data) => data.items,
  });
}

/**
 * Hook to fetch/create daily note
 * 
 * Note: This can create new daily, monthly, and yearly pages.
 * We invalidate the pages cache to ensure new pages appear in All Pages view.
 */

export function useDailyNote(date?: Date) {
  const queryClient = useQueryClient();
  const dateStr = formatLocalDate(date ?? new Date());
  
  return useQuery({
    queryKey: nodeKeys.daily(dateStr),
    queryFn: async () => {
      const node = await nodesApi.getOrCreateDaily(dateStr);
      // Also populate the detail cache so mutations can update it
      queryClient.setQueryData(nodeKeys.detail(node.id, { include_children: true }), node);
      // Invalidate pages list since this might have created new day/month/year pages
      queryClient.invalidateQueries({ queryKey: nodeKeys.pages() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.dailyList() });
      return node;
    },

  });
}

/**
 * Hook to fetch today's note
 */

export function useTodayNote() {
  return useDailyNote(new Date());
}

/**
 * Hook to fetch/create monthly note
 * 
 * Note: This can create new monthly and yearly pages.
 * We invalidate the pages cache to ensure new pages appear in All Pages view.
 */

export function useMonthlyNote(year: number, month: number) {
  const queryClient = useQueryClient();
  
  return useQuery({
    queryKey: nodeKeys.monthly(year, month),
    queryFn: async () => {
      const node = await nodesApi.getOrCreateMonthly(year, month);
      // Invalidate pages list since this might have created new month/year pages
      queryClient.invalidateQueries({ queryKey: nodeKeys.pages() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      return node;
    },
    enabled: year >= 1900 && month >= 1 && month <= 12,

  });
}

/**
 * Hook to fetch/create yearly note
 * 
 * Note: This can create a new yearly page.
 * We invalidate the pages cache to ensure new pages appear in All Pages view.
 */

export function useYearlyNote(year: number) {
  const queryClient = useQueryClient();
  
  return useQuery({
    queryKey: nodeKeys.yearly(year),
    queryFn: async () => {
      const node = await nodesApi.getOrCreateYearly(year);
      // Invalidate pages list since this might have created a new year page
      queryClient.invalidateQueries({ queryKey: nodeKeys.pages() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      return node;
    },
    enabled: year >= 1900,

  });
}

/**
 * Hook to fetch all pages
 * @param options.includeChildren - Include nested child pages
 * @param options.rootOnly - Only return root pages (no parent)
 */

