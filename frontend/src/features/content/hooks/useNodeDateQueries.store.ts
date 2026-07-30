/**
 * useNodeDateQueries.store — synchronous daily / monthly / yearly note helpers
 * that need the legacy WorkspaceStore type.
 *
 * These are kept in a separate file so the production `useNodeDateQueries` hook
 * does not import `WorkspaceStore` directly. Legacy callers and tests can still
 * use the synchronous helpers by importing from this module.
 */

import type { BatchNodeDailyResponse } from '@/types/api';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { queryNodes } from '@/core/query/queryNodes';
import { projectNode } from '@/core/adapters/nodeProjection';
import type { WorkspaceStore, NodeRow } from '@/core/store';
import type { Node } from '@/types/api';
import { nodeNameToText } from '@/features/queries';
import {
  dateStrToDayUuid,
  yearMonthToMonthUuid,
  yearToYearUuid,
} from '@/utils/dateUuid';

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
  const dayNodes = queryNodes(store, {
    classIds: [SYSTEM_CLASS_UUIDS.day],
    query: dateStr,
    projectionDepth: 0,
  });
  return findDateNoteByName(dayNodes, dateStr);
}

function findMonthlyNoteByName(store: WorkspaceStore, label: string): Node | undefined {
  const monthNodes = queryNodes(store, {
    classIds: [SYSTEM_CLASS_UUIDS.month],
    query: label,
    projectionDepth: 0,
  });
  return findDateNoteByName(monthNodes, label);
}

function findYearlyNoteByName(store: WorkspaceStore, label: string): Node | undefined {
  const yearNodes = queryNodes(store, {
    classIds: [SYSTEM_CLASS_UUIDS.year],
    query: label,
    projectionDepth: 0,
  });
  return findDateNoteByName(yearNodes, label);
}

function getOrCreateDateNote(
  store: WorkspaceStore,
  identity: DateNoteIdentity,
  findByName: () => Node | undefined,
  parentId?: string | null,
): Node {
  const { nodeId, label, classId } = identity;
  const existingRow = store.getNode(nodeId);
  if (existingRow?.classIds.includes(classId)) {
    const existing = projectNode(store, nodeId)!;
    if (parentId !== undefined && existing.parent_uuid !== parentId) {
      store.moveNode(nodeId, parentId);
      return projectNode(store, nodeId)!;
    }
    return existing;
  }
  const existingByName = findByName();
  if (existingByName) {
    if (parentId !== undefined && existingByName.parent_uuid !== parentId) {
      store.moveNode(existingByName.uuid, parentId);
      return projectNode(store, existingByName.uuid)!;
    }
    return existingByName;
  }

  store.createNode({ nodeId, kind: 'page', parentId: parentId ?? null, classIds: [classId] });
  setDatePageContent(store, nodeId, label);
  return projectNode(store, nodeId)!;
}

/**
 * Get or create a daily journal page in the local-first core store.
 * Ensures the full year → month → day hierarchy exists.
 */
export function getOrCreateDailyNote(store: WorkspaceStore, dateStr: string): Node {
  const [yearStr, monthStr] = dateStr.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);

  getOrCreateYearlyNote(store, year);
  const monthly = getOrCreateMonthlyNote(store, year, month);

  return getOrCreateDateNote(
    store,
    dailyNoteIdentity(dateStr),
    () => findDayNoteByName(store, dateStr),
    monthly.uuid,
  );
}

/**
 * Get or create a monthly journal page in the local-first core store.
 * Ensures the year parent exists.
 */
export function getOrCreateMonthlyNote(
  store: WorkspaceStore,
  year: number,
  month: number,
): Node {
  const yearly = getOrCreateYearlyNote(store, year);

  return getOrCreateDateNote(
    store,
    monthlyNoteIdentity(year, month),
    () => findMonthlyNoteByName(store, `${year}-${String(month).padStart(2, '0')}`),
    yearly.uuid,
  );
}

/**
 * Get or create a yearly journal page in the local-first core store.
 */
export function getOrCreateYearlyNote(store: WorkspaceStore, year: number): Node {
  return getOrCreateDateNote(
    store,
    yearlyNoteIdentity(year),
    () => findYearlyNoteByName(store, `${year}`),
    null,
  );
}

/**
 * Batch get-or-create daily journal pages in the local-first core store.
 */
export function batchGetOrCreateDailyNotes(
  store: WorkspaceStore,
  dates: string[],
): BatchNodeDailyResponse {
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

export type { NodeRow };
