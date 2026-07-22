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
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import { queryNodes } from '@/core/query/queryNodes';
import { projectNode } from '@/core/adapters/nodeProjection';
import type { WorkspaceStore, NodeRow } from '@/core/store';
import type { IWorkspaceStoreClient } from '@/core/worker/workerProtocol';
import { nodeNameToText } from '@/features/queries';
import { dateStrToDayUuid, yearMonthToMonthUuid, yearToYearUuid } from '@/utils/dateUuid';
import { formatLocalDate } from './useNodeQueries.utils';

interface DateNoteResult {
  data: Node | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => { data: Node | undefined };
}

interface DateNoteIdentity {
  nodeId: string;
  label: string;
  classId: string;
}

const DAILY_PAGES_QUERY = { classIds: [SYSTEM_CLASS_UUIDS.day], projectionDepth: 0 };

function dailyNoteIdentity(dateStr: string): DateNoteIdentity {
  return {
    nodeId: dateStrToDayUuid(dateStr),
    label: dateStr,
    classId: SYSTEM_CLASS_UUIDS.day,
  };
}

function monthlyNoteIdentity(year: number, month: number): DateNoteIdentity {
  return {
    nodeId: yearMonthToMonthUuid(year, month),
    label: `${year}-${String(month).padStart(2, '0')}`,
    classId: SYSTEM_CLASS_UUIDS.month,
  };
}

function yearlyNoteIdentity(year: number): DateNoteIdentity {
  return {
    nodeId: yearToYearUuid(year),
    label: `${year}`,
    classId: SYSTEM_CLASS_UUIDS.year,
  };
}

function findDateNoteByName(nodes: Node[], targetName: string): Node | undefined {
  return nodes.find((n) => nodeNameToText(n.name) === targetName);
}

// ─── Synchronous helpers (kept for legacy callers that still hold a WorkspaceStore) ───

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
  return findDateNoteByName(dayNodes, dateStr);
}

function findMonthlyNoteByName(store: WorkspaceStore, label: string): Node | undefined {
  const monthNodes = queryNodes(store, { classIds: [SYSTEM_CLASS_UUIDS.month], query: label, projectionDepth: 0 });
  return findDateNoteByName(monthNodes, label);
}

function findYearlyNoteByName(store: WorkspaceStore, label: string): Node | undefined {
  const yearNodes = queryNodes(store, { classIds: [SYSTEM_CLASS_UUIDS.year], query: label, projectionDepth: 0 });
  return findDateNoteByName(yearNodes, label);
}

function getOrCreateDateNote(
  store: WorkspaceStore,
  identity: DateNoteIdentity,
  findByName: () => Node | undefined
): Node {
  const { nodeId, label, classId } = identity;
  const existingRow = store.getNode(nodeId);
  if (existingRow?.classIds.includes(classId)) {
    return projectNode(store, nodeId)!;
  }
  const existingByName = findByName();
  if (existingByName) return existingByName;

  store.createNode({ nodeId, kind: 'page', parentId: null, classIds: [classId] });
  setDatePageContent(store, nodeId, label);
  return projectNode(store, nodeId)!;
}

/**
 * Get or create a daily journal page in the local-first core store.
 */
export function getOrCreateDailyNote(store: WorkspaceStore, dateStr: string): Node {
  return getOrCreateDateNote(store, dailyNoteIdentity(dateStr), () => findDayNoteByName(store, dateStr));
}

/**
 * Get or create a monthly journal page in the local-first core store.
 */
export function getOrCreateMonthlyNote(store: WorkspaceStore, year: number, month: number): Node {
  return getOrCreateDateNote(store, monthlyNoteIdentity(year, month), () => findMonthlyNoteByName(store, `${year}-${String(month).padStart(2, '0')}`));
}

/**
 * Get or create a yearly journal page in the local-first core store.
 */
export function getOrCreateYearlyNote(store: WorkspaceStore, year: number): Node {
  return getOrCreateDateNote(store, yearlyNoteIdentity(year), () => findYearlyNoteByName(store, `${year}`));
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
  return queryNodes(store, DAILY_PAGES_QUERY);
}

// ─── Asynchronous helpers for worker-backed hooks ───

async function findDayNoteByNameClient(
  client: IWorkspaceStoreClient,
  dateStr: string
): Promise<Node | undefined> {
  const dayNodes = await client.query<Node[]>('queryNodes', [
    { classIds: [SYSTEM_CLASS_UUIDS.day], query: dateStr, projectionDepth: 0 },
  ]);
  return findDateNoteByName(dayNodes, dateStr);
}

async function findMonthlyNoteByNameClient(
  client: IWorkspaceStoreClient,
  label: string
): Promise<Node | undefined> {
  const monthNodes = await client.query<Node[]>('queryNodes', [
    { classIds: [SYSTEM_CLASS_UUIDS.month], query: label, projectionDepth: 0 },
  ]);
  return findDateNoteByName(monthNodes, label);
}

async function findYearlyNoteByNameClient(
  client: IWorkspaceStoreClient,
  label: string
): Promise<Node | undefined> {
  const yearNodes = await client.query<Node[]>('queryNodes', [
    { classIds: [SYSTEM_CLASS_UUIDS.year], query: label, projectionDepth: 0 },
  ]);
  return findDateNoteByName(yearNodes, label);
}

async function getOrCreateDateNoteClient(
  client: IWorkspaceStoreClient,
  identity: DateNoteIdentity,
  findByName: () => Promise<Node | undefined>
): Promise<Node> {
  const { nodeId, label, classId } = identity;
  const existingRow = await client.query<NodeRow | undefined>('getNode', [nodeId]);
  if (existingRow?.classIds.includes(classId)) {
    const projected = await client.query<Node | undefined>('projectNode', [nodeId]);
    if (projected) return projected;
  }
  const existingByName = await findByName();
  if (existingByName) return existingByName;

  await client.mutate<void>('createNode', [
    { nodeId, kind: 'page', parentId: null, classIds: [classId] },
  ]);
  await client.mutate<void>('setNodeText', [nodeId, label]);
  const projected = await client.query<Node | undefined>('projectNode', [nodeId]);
  if (!projected) throw new Error(`Failed to project ${classId} note ${nodeId}`);
  return projected;
}

export async function getOrCreateDailyNoteClient(
  client: IWorkspaceStoreClient,
  dateStr: string
): Promise<Node> {
  return getOrCreateDateNoteClient(client, dailyNoteIdentity(dateStr), () =>
    findDayNoteByNameClient(client, dateStr)
  );
}

async function getOrCreateMonthlyNoteClient(
  client: IWorkspaceStoreClient,
  year: number,
  month: number
): Promise<Node> {
  return getOrCreateDateNoteClient(client, monthlyNoteIdentity(year, month), () =>
    findMonthlyNoteByNameClient(client, `${year}-${String(month).padStart(2, '0')}`)
  );
}

async function getOrCreateYearlyNoteClient(
  client: IWorkspaceStoreClient,
  year: number
): Promise<Node> {
  return getOrCreateDateNoteClient(client, yearlyNoteIdentity(year), () =>
    findYearlyNoteByNameClient(client, `${year}`)
  );
}

async function listDailyPagesFromStoreClient(client: IWorkspaceStoreClient): Promise<Node[]> {
  return client.query<Node[]>('queryNodes', [DAILY_PAGES_QUERY]);
}

// ─── Hooks ───

export function useExistingDailyPages() {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceUuid ?? '');
  const [data, setData] = useState<Node[]>([]);

  useEffect(() => {
    if (!client) {
      setData([]);
      return;
    }
    let cancelled = false;
    const update = async (): Promise<void> => {
      const pages = await listDailyPagesFromStoreClient(client);
      if (!cancelled) setData(pages);
    };
    update();
    const unsubscribe = client.subscribe(null, update);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client]);

  return { data, isLoading, error, refetch: () => ({ data }) };
}

/**
 * Hook to fetch/create daily note
 */
export function useDailyNote(date?: Date): DateNoteResult {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceUuid ?? '');
  const [data, setData] = useState<Node | undefined>(undefined);
  const dateStr = formatLocalDate(date ?? new Date());

  useEffect(() => {
    if (!client) {
      setData(undefined);
      return;
    }
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const run = async (): Promise<void> => {
      const node = await getOrCreateDailyNoteClient(client, dateStr);
      if (cancelled) return;
      setData(node);
      const nodeId = node.uuid;
      const update = async (): Promise<void> => {
        const refreshed = await client.query<Node | undefined>('projectNode', [nodeId]);
        if (!cancelled) setData(refreshed ?? undefined);
      };
      update();
      unsubscribe = client.subscribe(nodeId, update);
    };
    run();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [client, dateStr]);

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
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceUuid ?? '');
  const [data, setData] = useState<Node | undefined>(undefined);

  useEffect(() => {
    if (!client || year < 1900 || month < 1 || month > 12) {
      setData(undefined);
      return;
    }
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const run = async (): Promise<void> => {
      const node = await getOrCreateMonthlyNoteClient(client, year, month);
      if (cancelled) return;
      setData(node);
      const nodeId = node.uuid;
      const update = async (): Promise<void> => {
        const refreshed = await client.query<Node | undefined>('projectNode', [nodeId]);
        if (!cancelled) setData(refreshed ?? undefined);
      };
      update();
      unsubscribe = client.subscribe(nodeId, update);
    };
    run();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [client, year, month]);

  return { data, isLoading, error, refetch: () => ({ data }) };
}

/**
 * Hook to fetch/create yearly note
 */
export function useYearlyNote(year: number): DateNoteResult {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceUuid ?? '');
  const [data, setData] = useState<Node | undefined>(undefined);

  useEffect(() => {
    if (!client || year < 1900) {
      setData(undefined);
      return;
    }
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const run = async (): Promise<void> => {
      const node = await getOrCreateYearlyNoteClient(client, year);
      if (cancelled) return;
      setData(node);
      const nodeId = node.uuid;
      const update = async (): Promise<void> => {
        const refreshed = await client.query<Node | undefined>('projectNode', [nodeId]);
        if (!cancelled) setData(refreshed ?? undefined);
      };
      update();
      unsubscribe = client.subscribe(nodeId, update);
    };
    run();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [client, year]);

  return { data, isLoading, error, refetch: () => ({ data }) };
}
