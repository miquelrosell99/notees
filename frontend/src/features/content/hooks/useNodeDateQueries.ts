/**
 * useNodeDateQueries — local-first daily / monthly / yearly page hooks.
 *
 * Replaces the legacy `/api/nodes/daily`, `/api/nodes/monthly`, `/api/nodes/yearly`,
 * and `/api/nodes/daily/list` API calls with core store operations.
 */

import { useEffect, useState } from 'react';
import type { Node } from '@/types/api';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import type { NodeRow } from '@/core/store';
import type { IWorkspaceStoreClient } from '@/core/worker/workerProtocol';
import { nodeNameToText } from '@/features/queries';
import { dateStrToDayUuid, yearMonthToMonthUuid, yearToYearUuid } from '@/utils/dateUuid';
import { formatLocalDate } from './useNodeQueries.utils';

export {
  getOrCreateDailyNote,
  getOrCreateMonthlyNote,
  getOrCreateYearlyNote,
  batchGetOrCreateDailyNotes,
  listDailyPagesFromStore,
} from './useNodeDateQueries.store';

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
  findByName: () => Promise<Node | undefined>,
  parentId?: string | null
): Promise<Node> {
  const { nodeId, label, classId } = identity;
  const existingRow = await client.query<NodeRow | undefined>('getNode', [nodeId]);
  if (existingRow?.classIds.includes(classId)) {
    const projected = await client.query<Node | undefined>('projectNode', [nodeId]);
    if (projected) {
      if (parentId !== undefined && projected.parent_uuid !== parentId) {
        await client.mutate<void>('recordMoveNode', [projected.uuid, parentId]);
        const refreshed = await client.query<Node | undefined>('projectNode', [nodeId]);
        if (refreshed) return refreshed;
      }
      return projected;
    }
  }
  const existingByName = await findByName();
  if (existingByName) {
    if (parentId !== undefined && existingByName.parent_uuid !== parentId) {
      await client.mutate<void>('recordMoveNode', [existingByName.uuid, parentId]);
      const refreshed = await client.query<Node | undefined>('projectNode', [existingByName.uuid]);
      if (refreshed) return refreshed;
    }
    return existingByName;
  }

  await client.mutate<void>('createNode', [
    { nodeId, kind: 'page', parentId: parentId ?? null, classIds: [classId] },
  ]);
  await client.mutate<void>('setNodeText', [nodeId, label]);
  const projected = await client.query<Node | undefined>('projectNode', [nodeId]);
  if (!projected) throw new Error(`Failed to project ${classId} note ${nodeId}`);
  return projected;
}

/**
 * Worker-client (async) version of getOrCreateDailyNote.
 *
 * The synchronous `getOrCreateDailyNote(store, dateStr)` export is still available
 * for callers that hold a `WorkspaceStore` directly.
 */
export async function getOrCreateDailyNoteClient(
  client: IWorkspaceStoreClient,
  dateStr: string
): Promise<Node> {
  const [yearStr, monthStr] = dateStr.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);

  await getOrCreateYearlyNoteClient(client, year);
  const monthly = await getOrCreateMonthlyNoteClient(client, year, month);

  return getOrCreateDateNoteClient(
    client,
    dailyNoteIdentity(dateStr),
    () => findDayNoteByNameClient(client, dateStr),
    monthly.uuid
  );
}

export async function getOrCreateMonthlyNoteClient(
  client: IWorkspaceStoreClient,
  year: number,
  month: number
): Promise<Node> {
  const yearly = await getOrCreateYearlyNoteClient(client, year);

  return getOrCreateDateNoteClient(
    client,
    monthlyNoteIdentity(year, month),
    () => findMonthlyNoteByNameClient(client, `${year}-${String(month).padStart(2, '0')}`),
    yearly.uuid
  );
}

export async function getOrCreateYearlyNoteClient(
  client: IWorkspaceStoreClient,
  year: number
): Promise<Node> {
  return getOrCreateDateNoteClient(
    client,
    yearlyNoteIdentity(year),
    () => findYearlyNoteByNameClient(client, `${year}`),
    null
  );
}

export async function listDailyPagesFromStoreClient(client: IWorkspaceStoreClient): Promise<Node[]> {
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
