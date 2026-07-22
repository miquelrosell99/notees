/**
 * useGanttData — Extracts and prepares Gantt-specific data from generic Node[].
 *
 * Keeps GanttView focused on rendering while this hook handles:
 * - Day-node resolution (dates are stored as node references)
 * - Date range computation
 * - Row building (grouping + sorting)
 */
import { useMemo, useState, useCallback, useEffect } from 'react';
import type { Node } from '@/types';
import type { Property } from '@/types/api';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
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
  dayNodeMap: Map<string, Node>;
  isLoading: boolean;
  optimisticOverrides: Map<string | number, { startDate: Date; endDate: Date | null }>;
  setOptimisticOverride: (
    nodeUuid: string,
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
  // Collect day-node UUIDs from date property values
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

  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client, isLoading: storeLoading } = useWorkspaceStoreClient(workspaceUuid ?? '');

  // Resolve day nodes from the local-first core store
  const [dayNodeMap, setDayNodeMap] = useState<Map<string, Node>>(new Map());

  useEffect(() => {
    if (!client) {
      setDayNodeMap(new Map());
      return;
    }

    let cancelled = false;
    const update = async (): Promise<void> => {
      const map = new Map<string, Node>();
      for (const nodeUuid of dayNodeUuids) {
        const node = await client.query<Node | null>('getNodeByUuid', [nodeUuid]);
        if (node) map.set(nodeUuid, node);
      }
      if (!cancelled) setDayNodeMap(map);
    };

    update();
    const unsubscribe = client.subscribe(null, update);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, dayNodeUuids]);

  const isLoading = dayNodeUuids.length > 0 && storeLoading;

  // Optimistic date overrides while API calls are in-flight
  const [optimisticOverrides, setOptimisticOverrides] = useState<
    Map<string | number, { startDate: Date; endDate: Date | null }>
  >(new Map());

  const setOptimisticOverride = useCallback(
    (nodeUuid: string, override: { startDate: Date; endDate: Date | null } | null) => {
      setOptimisticOverrides((prev) => {
        const next = new Map(prev);
        if (override === null) {
          next.delete(nodeUuid);
        } else {
          next.set(nodeUuid, override);
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
        const override = optimisticOverrides.get(node.uuid) ?? optimisticOverrides.get(node.uuid);
        const props = node.properties_uuid as Record<string, unknown> | undefined;
        const startDate =
          override?.startDate ?? resolveDate(props?.[startDateProperty.uuid], dayNodeMap);
        if (!startDate) return [];
        const endDate = override
          ? override.endDate
          : endDateProperty
            ? resolveDate(props?.[endDateProperty.uuid], dayNodeMap)
            : null;
        return [{ node, startDate, endDate }];
      })
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
  }, [nodes, startDateProperty, endDateProperty, dayNodeMap, optimisticOverrides]);

  // Build page map for grouping
  const pageMap = useMemo(
    () => new Map(nodes.filter((n) => n.is_page).map((n) => [n.uuid, n])),
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
