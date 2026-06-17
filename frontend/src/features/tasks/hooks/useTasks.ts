/**
 * React Query hook for task views.
 */
import { useMemo } from 'react';
import { useQuery_ } from '@/features/content';
import {
  buildTasksQueryAST,
  buildTodayOverdueQueryAST,
  buildFutureQueryAST,
} from '@/utils/taskQueries';
import { taskKeys } from '@/hooks/queryKeys';
import type { QueryExecuteRequest } from '@/types/nodeView';

type TaskTab = 'all' | 'today' | 'future';

function getQueryForTab(tab: TaskTab): QueryExecuteRequest {
  switch (tab) {
    case 'all':
      return { query_ast: buildTasksQueryAST() };
    case 'today':
      return { query_ast: buildTodayOverdueQueryAST() };
    case 'future':
      return { query_ast: buildFutureQueryAST() };
  }
}

export function useTasks(activeTab: TaskTab = 'all', options?: { enabled?: boolean }) {
  const request = useMemo(() => getQueryForTab(activeTab), [activeTab]);
  return useQuery_(request, {
    enabled: options?.enabled ?? true,
    queryKey: taskKeys.view(activeTab),
  });
}
