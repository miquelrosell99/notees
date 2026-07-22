/**
 * useNodeDateQueries — local-first daily / monthly / yearly page hooks.
 *
 * Replaces the legacy `/api/nodes/daily`, `/api/nodes/monthly`, `/api/nodes/yearly`,
 * and `/api/nodes/daily/list` API calls with core store operations.
 */

import { useEffect, useState } from 'react';
import type { Node } from '@/types/api';
import type { BatchNodeDailyResponse } from '@/types/api';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';
import { queryNodes } from '@/core/query/queryNodes';
import { projectNode } from '@/core/adapters/nodeProjection';
import type { WorkspaceStore } from '@/core/store';
import { nodeNameToText } from '@/features/queries';
import { dateStrToDayUuid, yearMonthToMonthUuid, yearToYearUuid } from '@/utils/dateUuid';
import { formatLocalDate } from './useNodeQueries.utils';

interface DateNoteResult {
  data: Node | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => { data: Node | undefined };
}

function setDatePageContent(store: WorkspaceStore, nodeId: string, name: string): void {
  store.updateText(nodeId, (text) => {
    const current = text.toPlaintext();
    if (current) {
      text.delete(0, current.length);
    }
    text.insert(0, name);
  });
}

function findDayNoteByName(store: WorkspaceStore, dateStr: string): Node | undefined {
  const dayNodes = queryNodes(store, { classIds: [SYSTEM_CLASS_UUIDS.day], query: dateStr, projectionDepth: 0 });
  return dayNodes.find((n) => nodeNameToText(n.name) === dateStr);
}

function findMonthlyNoteByName(store: WorkspaceStore, label: string): Node | undefined {
  const monthNodes = queryNodes(store, { classIds: [SYSTEM_CLASS_UUIDS.month], query: label, projectionDepth: 0 });
  return monthNodes.find((n) => nodeNameToText(n.name) === label);
}

function findYearlyNoteByName(store: WorkspaceStore, label: string): Node | undefined {
  const yearNodes = queryNodes(store, { classIds: [SYSTEM_CLASS_UUIDS.year], query: label, projectionDepth: 0 });
  return yearNodes.find((n) => nodeNameToText(n.name) === label);
}

/**
 * Get or create a daily journal page in the local-first core store.
 */
export function getOrCreateDailyNote(store: WorkspaceStore, dateStr: string): Node {
  const nodeId = dateStrToDayUuid(dateStr);
  const existingRow = store.getNode(nodeId);
  if (existingRow?.classIds.includes(SYSTEM_CLASS_UUIDS.day)) {
    return projectNode(store, nodeId)!;
  }
  const existingByName = findDayNoteByName(store, dateStr);
  if (existingByName) return existingByName;

  store.createNode({ nodeId, kind: 'page', parentId: null, classIds: [SYSTEM_CLASS_UUIDS.day] });
  setDatePageContent(store, nodeId, dateStr);
  return projectNode(store, nodeId)!;
}

/**
 * Get or create a monthly journal page in the local-first core store.
 */
export function getOrCreateMonthlyNote(store: WorkspaceStore, year: number, month: number): Node {
  const label = `${year}-${String(month).padStart(2, '0')}`;
  const nodeId = yearMonthToMonthUuid(year, month);
  const existingRow = store.getNode(nodeId);
  if (existingRow?.classIds.includes(SYSTEM_CLASS_UUIDS.month)) {
    return projectNode(store, nodeId)!;
  }
  const existingByName = findMonthlyNoteByName(store, label);
  if (existingByName) return existingByName;

  store.createNode({ nodeId, kind: 'page', parentId: null, classIds: [SYSTEM_CLASS_UUIDS.month] });
  setDatePageContent(store, nodeId, label);
  return projectNode(store, nodeId)!;
}

/**
 * Get or create a yearly journal page in the local-first core store.
 */
export function getOrCreateYearlyNote(store: WorkspaceStore, year: number): Node {
  const label = `${year}`;
  const nodeId = yearToYearUuid(year);
  const existingRow = store.getNode(nodeId);
  if (existingRow?.classIds.includes(SYSTEM_CLASS_UUIDS.year)) {
    return projectNode(store, nodeId)!;
  }
  const existingByName = findYearlyNoteByName(store, label);
  if (existingByName) return existingByName;

  store.createNode({ nodeId, kind: 'page', parentId: null, classIds: [SYSTEM_CLASS_UUIDS.year] });
  setDatePageContent(store, nodeId, label);
  return projectNode(store, nodeId)!;
}

/**
 * Batch get-or-create daily journal pages in the local-first core store.
 */
export function batchGetOrCreateDailyNotes(store: WorkspaceStore, dates: string[]): BatchNodeDailyResponse {
  return {
    results: dates.map((date) => {
      try {
        const node = getOrCreateDailyNote(store, date);
        return { date, success: true, node };
      } catch (err) {
        return {
          date,
          success: false,
          error: err instanceof Error ? err.message : 'Failed to create daily page',
        };
      }
    }),
  };
}

/**
 * List all existing daily journal pages in the local-first core store.
 */
export function listDailyPagesFromStore(store: WorkspaceStore): Node[] {
  return queryNodes(store, { classIds: [SYSTEM_CLASS_UUIDS.day], projectionDepth: 0 });
}

export function useExistingDailyPages() {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store, isLoading, error } = useWorkspaceStore(workspaceUuid ?? '');
  const [data, setData] = useState<Node[]>([]);

  useEffect(() => {
    if (!store) {
      setData([]);
      return;
    }
    setData(listDailyPagesFromStore(store));
  }, [store]);

  return { data, isLoading, error, refetch: () => ({ data }) };
}

/**
 * Hook to fetch/create daily note
 */
export function useDailyNote(date?: Date): DateNoteResult {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store, isLoading, error } = useWorkspaceStore(workspaceUuid ?? '');
  const [data, setData] = useState<Node | undefined>(undefined);
  const dateStr = formatLocalDate(date ?? new Date());

  useEffect(() => {
    if (!store) {
      setData(undefined);
      return;
    }
    const node = getOrCreateDailyNote(store, dateStr);
    setData(node);
    const nodeId = node.uuid;
    const update = (): void => {
      setData(projectNode(store, nodeId) ?? undefined);
    };
    update();
    return store.subscribe(nodeId, update);
  }, [store, dateStr]);

  return { data, isLoading, error, refetch: () => ({ data }) };
}

/**
 * Hook to fetch today's note
 */
export function useTodayNote(): DateNoteResult {
  return useDailyNote(new Date());
}

/**
 * Hook to fetch/create monthly note
 */
export function useMonthlyNote(year: number, month: number): DateNoteResult {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store, isLoading, error } = useWorkspaceStore(workspaceUuid ?? '');
  const [data, setData] = useState<Node | undefined>(undefined);

  useEffect(() => {
    if (!store || year < 1900 || month < 1 || month > 12) {
      setData(undefined);
      return;
    }
    const node = getOrCreateMonthlyNote(store, year, month);
    setData(node);
    const nodeId = node.uuid;
    const update = (): void => {
      setData(projectNode(store, nodeId) ?? undefined);
    };
    update();
    return store.subscribe(nodeId, update);
  }, [store, year, month]);

  return { data, isLoading, error, refetch: () => ({ data }) };
}

/**
 * Hook to fetch/create yearly note
 */
export function useYearlyNote(year: number): DateNoteResult {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store, isLoading, error } = useWorkspaceStore(workspaceUuid ?? '');
  const [data, setData] = useState<Node | undefined>(undefined);

  useEffect(() => {
    if (!store || year < 1900) {
      setData(undefined);
      return;
    }
    const node = getOrCreateYearlyNote(store, year);
    setData(node);
    const nodeId = node.uuid;
    const update = (): void => {
      setData(projectNode(store, nodeId) ?? undefined);
    };
    update();
    return store.subscribe(nodeId, update);
  }, [store, year]);

  return { data, isLoading, error, refetch: () => ({ data }) };
}
