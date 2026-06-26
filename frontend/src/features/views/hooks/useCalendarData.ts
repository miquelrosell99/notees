/**
 * React Query hook for resolving calendar event data.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getNode } from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';
import { dateFromUuid } from '@/types/api';
import type { Node } from '@/types';
import type { Property } from '@/types/api';

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function startOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isBeforeDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() < b.getFullYear() ||
    (a.getFullYear() === b.getFullYear() && a.getMonth() < b.getMonth()) ||
    (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() < b.getDate())
  );
}

function isAfterDay(a: Date, b: Date): boolean {
  return isBeforeDay(b, a);
}

function resolveDate(val: unknown, map: Map<string, Node>): Date | null {
  if (typeof val !== 'string') return null;
  const n = map.get(val);
  return n ? dateFromUuid(n.uuid) : null;
}

export { addDays, startOfMonth, startOfWeek, isSameDay, isBeforeDay, isAfterDay };

export interface CalendarEvent {
  node: Node;
  startDate: Date;
  endDate: Date | null;
}

export function useCalendarData(
  nodes: Node[],
  startDateProperty: Property | undefined,
  endDateProperty: Property | undefined
) {
  const dayNodeUuids = useMemo<string[]>(() => {
    const uuids = new Set<string>();
    for (const node of nodes) {
      const props = node.properties_uuid as Record<string, unknown> | undefined;
      if (!props) continue;
      if (startDateProperty) {
        const v = props[startDateProperty.uuid];
        if (typeof v === 'string') uuids.add(v);
      }
      if (endDateProperty) {
        const v = props[endDateProperty.uuid];
        if (typeof v === 'string') uuids.add(v);
      }
    }
    return Array.from(uuids);
  }, [nodes, startDateProperty, endDateProperty]);

  const { data: dayNodeMap = new Map<string, Node>(), isLoading } = useQuery({
    queryKey: nodeKeys.ganttDayNodes(dayNodeUuids),
    queryFn: async (): Promise<Map<string, Node>> => {
      const fetched = await Promise.all(dayNodeUuids.map((nodeUuid) => getNode(nodeUuid)));
      return new Map(fetched.map((n) => [n.uuid, n]));
    },
    enabled: dayNodeUuids.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  const events = useMemo<CalendarEvent[]>(() => {
    if (!startDateProperty) return [];
    return nodes
      .flatMap((node) => {
        const props = node.properties_uuid as Record<string, unknown> | undefined;
        const startDate = resolveDate(props?.[startDateProperty.uuid], dayNodeMap);
        if (!startDate) return [];
        const endDate = endDateProperty
          ? resolveDate(props?.[endDateProperty.uuid], dayNodeMap)
          : null;
        return [{ node, startDate, endDate }];
      })
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
  }, [nodes, startDateProperty, endDateProperty, dayNodeMap]);

  return { events, isLoading };
}
