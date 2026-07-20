import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';
import { executeQuery } from '@/core/query/executeQuery';
import { taskKeys } from '@/hooks/queryKeys';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import { compareDayUuids, isDayUuid } from '@/utils/dateUuid';
import {
  buildPopupOverdueQueryAST,
  buildPopupTodayQueryAST,
  buildPopupUpcomingQueryAST,
  buildPopupUnscheduledQueryAST,
  buildPopupCompletedTodayQueryAST,
} from '@/utils/taskQueries';
import type { QueryExecuteRequest, QueryExecuteResponse } from '@/types/nodeView';
import type { Node } from '@/types/api';

export type PopupSection = 'overdue' | 'today' | 'upcoming' | 'unscheduled' | 'completed';

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
    case 'unscheduled':
      return { query_ast: buildPopupUnscheduledQueryAST(), include_properties: true, limit: 10 };
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
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store } = useWorkspaceStore(workspaceId ?? '');

  const runQuery = (section: PopupSection): Promise<QueryExecuteResponse> => {
    if (!store) {
      return Promise.resolve({ nodes: [], groups: undefined, total_count: 0, metrics: undefined });
    }
    return Promise.resolve(executeQuery(store, getPopupQueryForSection(section)));
  };

  const overdue = useQuery({
    queryKey: taskKeys.popup('overdue'),
    queryFn: () => runQuery('overdue'),
    staleTime: 30_000,
    enabled: !!store,
  });
  const today = useQuery({
    queryKey: taskKeys.popup('today'),
    queryFn: () => runQuery('today'),
    staleTime: 30_000,
    enabled: !!store,
  });
  const upcoming = useQuery({
    queryKey: taskKeys.popup('upcoming'),
    queryFn: () => runQuery('upcoming'),
    staleTime: 30_000,
    enabled: !!store,
  });
  const completed = useQuery({
    queryKey: taskKeys.popup('completed'),
    queryFn: () => runQuery('completed'),
    staleTime: 30_000,
    enabled: !!store,
  });
  const unscheduled = useQuery({
    queryKey: taskKeys.popup('unscheduled'),
    queryFn: () => runQuery('unscheduled'),
    staleTime: 30_000,
    enabled: !!store,
  });

  const sections = useMemo<Record<PopupSection, PopupSectionData>>(
    () => ({
      overdue: {
        nodes: [...(overdue.data?.nodes ?? [])].sort(byTaskDateAsc),
        totalCount: overdue.data?.total_count ?? overdue.data?.nodes.length ?? 0,
      },
      today: {
        nodes: today.data?.nodes ?? [],
        totalCount: today.data?.total_count ?? today.data?.nodes.length ?? 0,
      },
      upcoming: {
        nodes: [...(upcoming.data?.nodes ?? [])].sort(byTaskDateAsc),
        totalCount: upcoming.data?.total_count ?? upcoming.data?.nodes.length ?? 0,
      },
      completed: {
        nodes: completed.data?.nodes ?? [],
        totalCount: completed.data?.total_count ?? completed.data?.nodes.length ?? 0,
      },
      unscheduled: {
        nodes: [...(unscheduled.data?.nodes ?? [])].sort((a, b) =>
          (b.write_date ?? '').localeCompare(a.write_date ?? '')
        ),
        totalCount: unscheduled.data?.total_count ?? unscheduled.data?.nodes.length ?? 0,
      },
    }),
    [overdue.data, today.data, upcoming.data, completed.data, unscheduled.data],
  );

  const dueCount = sections.overdue.totalCount + sections.today.totalCount;
  const isLoading = overdue.isLoading || today.isLoading || upcoming.isLoading || completed.isLoading || unscheduled.isLoading;
  const isError = overdue.isError || today.isError || upcoming.isError || completed.isError || unscheduled.isError;
  const refetch = () => {
    void overdue.refetch();
    void today.refetch();
    void upcoming.refetch();
    void completed.refetch();
    void unscheduled.refetch();
  };

  return { sections, dueCount, isLoading, isError, refetch };
}
