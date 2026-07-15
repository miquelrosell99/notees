import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { executeQuery } from '@/api/nodeViews';
import { taskKeys } from '@/hooks/queryKeys';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import { compareDayUuids, isDayUuid } from '@/utils/dateUuid';
import {
  buildPopupOverdueQueryAST,
  buildPopupTodayQueryAST,
  buildPopupUpcomingQueryAST,
  buildPopupCompletedTodayQueryAST,
} from '@/utils/taskQueries';
import type { QueryExecuteRequest } from '@/types/nodeView';
import type { Node } from '@/types/api';

export type PopupSection = 'overdue' | 'today' | 'upcoming' | 'completed';

export interface PopupSectionData {
  nodes: Node[];
  totalCount: number;
}

export function getPopupQueryForSection(section: PopupSection): QueryExecuteRequest {
  switch (section) {
    case 'overdue':
      return { query_ast: buildPopupOverdueQueryAST(), include_properties: true };
    case 'today':
      return { query_ast: buildPopupTodayQueryAST(), include_properties: true };
    case 'upcoming':
      return { query_ast: buildPopupUpcomingQueryAST(7), include_properties: true, limit: 20 };
    case 'completed':
      return { query_ast: buildPopupCompletedTodayQueryAST(), include_properties: true, limit: 10 };
  }
}

/**
 * Best-effort date for a task row: scheduled day UUID, else deadline day UUID.
 * Returns null when neither property is a day-UUID string.
 */
export function getTaskDateUuid(node: Node): string | null {
  const props = node.properties_uuid as Record<string, unknown> | undefined;
  const scheduled = props?.[SYSTEM_PROPERTY_UUIDS.task_scheduled];
  if (typeof scheduled === 'string' && isDayUuid(scheduled)) return scheduled;
  const deadline = props?.[SYSTEM_PROPERTY_UUIDS.task_deadline];
  if (typeof deadline === 'string' && isDayUuid(deadline)) return deadline;
  return null;
}

function byTaskDateAsc(a: Node, b: Node): number {
  return compareDayUuids(getTaskDateUuid(a) ?? '', getTaskDateUuid(b) ?? '');
}

export function useTasksPopupData() {
  const overdue = useQuery({
    queryKey: taskKeys.popup('overdue'),
    queryFn: () => executeQuery(getPopupQueryForSection('overdue')),
    staleTime: 30_000,
  });
  const today = useQuery({
    queryKey: taskKeys.popup('today'),
    queryFn: () => executeQuery(getPopupQueryForSection('today')),
    staleTime: 30_000,
  });
  const upcoming = useQuery({
    queryKey: taskKeys.popup('upcoming'),
    queryFn: () => executeQuery(getPopupQueryForSection('upcoming')),
    staleTime: 30_000,
  });
  const completed = useQuery({
    queryKey: taskKeys.popup('completed'),
    queryFn: () => executeQuery(getPopupQueryForSection('completed')),
    staleTime: 30_000,
  });

  const sections = useMemo<Record<PopupSection, PopupSectionData>>(
    () => ({
      overdue: {
        nodes: [...(overdue.data?.nodes ?? [])].sort(byTaskDateAsc),
        totalCount: overdue.data?.total_count ?? 0,
      },
      today: {
        nodes: today.data?.nodes ?? [],
        totalCount: today.data?.total_count ?? 0,
      },
      upcoming: {
        nodes: [...(upcoming.data?.nodes ?? [])].sort(byTaskDateAsc),
        totalCount: upcoming.data?.total_count ?? 0,
      },
      completed: {
        nodes: completed.data?.nodes ?? [],
        totalCount: completed.data?.total_count ?? 0,
      },
    }),
    [overdue.data, today.data, upcoming.data, completed.data],
  );

  const dueCount = sections.overdue.totalCount + sections.today.totalCount;
  const isLoading = overdue.isLoading || today.isLoading || upcoming.isLoading || completed.isLoading;
  const isError = overdue.isError || today.isError || upcoming.isError || completed.isError;
  const refetch = () => {
    void overdue.refetch();
    void today.refetch();
    void upcoming.refetch();
    void completed.refetch();
  };

  return { sections, dueCount, isLoading, isError, refetch };
}
