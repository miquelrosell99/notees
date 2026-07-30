/**
 * Unit tests for repairDatePageHierarchy startup cleanup.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../../store';
import { uuidv7 } from '../../uuid';
import { createTestDatabase } from '../../__tests__/helpers';
import { repairDatePageHierarchy } from '../queryHelpers';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { dateStrToDayUuid, yearMonthToMonthUuid, yearToYearUuid } from '@/utils/dateUuid';

describe('repairDatePageHierarchy', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  async function makeStore() {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    return new WorkspaceStore(db, workspaceId, actorId);
  }

  it('fixes parent hierarchy for existing orphaned date pages', async () => {
    const store = await makeStore();
    const yearUuid = yearToYearUuid(2024);
    const monthUuid = yearMonthToMonthUuid(2024, 7);
    const dayUuid = dateStrToDayUuid('2024-07-30');

    // Simulate legacy date pages with no hierarchy.
    store.createNode({ nodeId: yearUuid, kind: 'page', parentId: null, classIds: [SYSTEM_CLASS_UUIDS.year] });
    store.setNodeText(yearUuid, '2024');
    store.createNode({ nodeId: monthUuid, kind: 'page', parentId: null, classIds: [SYSTEM_CLASS_UUIDS.month] });
    store.setNodeText(monthUuid, '2024-07');
    store.createNode({ nodeId: dayUuid, kind: 'page', parentId: null, classIds: [SYSTEM_CLASS_UUIDS.day] });
    store.setNodeText(dayUuid, '2024-07-30');

    repairDatePageHierarchy(store);

    const yearNode = store.getNode(yearUuid);
    const monthNode = store.getNode(monthUuid);
    const dayNode = store.getNode(dayUuid);

    expect(yearNode?.parentId).toBeNull();
    expect(monthNode?.parentId).toBe(yearUuid);
    expect(dayNode?.parentId).toBe(monthUuid);
  });

  it('does not change already-correct hierarchy', async () => {
    const store = await makeStore();
    const yearUuid = yearToYearUuid(2024);
    const monthUuid = yearMonthToMonthUuid(2024, 7);
    const dayUuid = dateStrToDayUuid('2024-07-30');

    store.createNode({ nodeId: yearUuid, kind: 'page', parentId: null, classIds: [SYSTEM_CLASS_UUIDS.year] });
    store.setNodeText(yearUuid, '2024');
    store.createNode({ nodeId: monthUuid, kind: 'page', parentId: yearUuid, classIds: [SYSTEM_CLASS_UUIDS.month] });
    store.setNodeText(monthUuid, '2024-07');
    store.createNode({ nodeId: dayUuid, kind: 'page', parentId: monthUuid, classIds: [SYSTEM_CLASS_UUIDS.day] });
    store.setNodeText(dayUuid, '2024-07-30');

    repairDatePageHierarchy(store);

    expect(store.getNode(yearUuid)?.parentId).toBeNull();
    expect(store.getNode(monthUuid)?.parentId).toBe(yearUuid);
    expect(store.getNode(dayUuid)?.parentId).toBe(monthUuid);
  });
});
