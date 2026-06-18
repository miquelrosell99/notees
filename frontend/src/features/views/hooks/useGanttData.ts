/**
 * useGanttData — Extracts and prepares Gantt-specific data from generic Node[].
 *
 * Keeps GanttView focused on rendering while this hook handles:
 * - Day-node resolution (dates are stored as node references)
 * - Date range computation
 * - Row building (grouping + sorting)
 */
import { useMemo, useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Node } from '@/types';
import type { Property } from '@/types/api';
import { getNode } from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';
import {
  resolveDate,
  getDateRange,
  buildRows,
  rowHeights,
} from '../renderers/GanttRenderer';
import type { GanttNodeItem } from '../renderers/GanttRenderer';

export interface GanttData {
  ganttNodeItems: GanttNodeItem[];
  rows: ReturnType<typeof buildRows>;
  dateRange: { start: Date; end: Date };
  totalContentHeight: number;
  dayNodeMap: Map<number, Node>;
  isLoading: boolean;
  optimisticOverrides: Map<number, { startDate: Date; endDate: Date | null }>;
  setOptimisticOverride: (
    nodeId: number,
    override: { startDate: Date; endDate: Date | null } | null
  ) => void;
}

export function useGanttData(
  nodes: Node[],
  startDateProperty: Property | undefined,
  endDateProperty: Property | undefined,
  groupBy?: string,
  groupByProperty?: Property,
): GanttData {
  // Collect day-node IDs from date property values
  const dayNodeIds = useMemo<number[]>(() => {
    const ids = new Set<number>();
    for (const node of nodes) {
      const props = node.properties as Record<number, unknown> | undefined;
      if (!props) continue;
      if (startDateProperty) {
        const v = props[startDateProperty.id];
        if (typeof v === 'number') ids.add(v);
      }
      if (endDateProperty) {
        const v = props[endDateProperty.id];
        if (typeof v === 'number') ids.add(v);
      }
    }
    return Array.from(ids);
  }, [nodes, startDateProperty, endDateProperty]);

  // Fetch day nodes to resolve numeric IDs into actual dates
  const { data: dayNodeMap = new Map<number, Node>(), isLoading } = useQuery({
    queryKey: nodeKeys.ganttDayNodes(dayNodeIds),
    queryFn: async (): Promise<Map<number, Node>> => {
      const fetched = await Promise.all(dayNodeIds.map((id) => getNode(id)));
      return new Map(fetched.map((n) => [n.id, n]));
    },
    enabled: dayNodeIds.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  // Optimistic date overrides while API calls are in-flight
  const [optimisticOverrides, setOptimisticOverrides] = useState<
    Map<number, { startDate: Date; endDate: Date | null }>
  >(new Map());

  const setOptimisticOverride = useCallback(
    (nodeId: number, override: { startDate: Date; endDate: Date | null } | null) => {
      setOptimisticOverrides((prev) => {
        const next = new Map(prev);
        if (override === null) {
          next.delete(nodeId);
        } else {
          next.set(nodeId, override);
        }
        return next;
      });
    },
    []
  );

  // Derive gantt items from nodes + resolved dates
  const ganttNodeItems = useMemo<GanttNodeItem[]>(() => {
    if (!startDateProperty) return [];
    return nodes
      .flatMap((node) => {
        const override = optimisticOverrides.get(node.id);
        const props = node.properties as Record<number, unknown> | undefined;
        const startDate =
          override?.startDate ?? resolveDate(props?.[startDateProperty.id], dayNodeMap);
        if (!startDate) return [];
        const endDate = override
          ? override.endDate
          : endDateProperty
            ? resolveDate(props?.[endDateProperty.id], dayNodeMap)
            : null;
        return [{ node, startDate, endDate }];
      })
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
  }, [nodes, startDateProperty, endDateProperty, dayNodeMap, optimisticOverrides]);

  // Build page map for grouping
  const pageMap = useMemo(
    () => new Map(nodes.filter((n) => n.is_page).map((n) => [n.id, n])),
    [nodes]
  );

  // Build rows (grouped or flat)
  const rows = useMemo(
    () => buildRows(ganttNodeItems, groupBy, groupByProperty, pageMap),
    [ganttNodeItems, groupBy, groupByProperty, pageMap]
  );

  const dateRange = useMemo(() => getDateRange(ganttNodeItems), [ganttNodeItems]);
  const totalContentHeight = useMemo(() => rowHeights(rows), [rows]);

  return {
    ganttNodeItems,
    rows,
    dateRange,
    totalContentHeight,
    dayNodeMap,
    isLoading,
    optimisticOverrides,
    setOptimisticOverride,
  };
}
