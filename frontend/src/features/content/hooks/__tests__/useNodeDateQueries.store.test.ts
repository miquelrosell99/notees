/**
 * Unit tests for date note hierarchy creation.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '@/core/store';
import { uuidv7 } from '@/core/uuid';
import { createTestDatabase } from '@/core/__tests__/helpers';
import {
  getOrCreateDailyNote,
  getOrCreateMonthlyNote,
  getOrCreateYearlyNote,
} from '../useNodeDateQueries.store';
import { dateStrToDayUuid, yearMonthToMonthUuid, yearToYearUuid } from '@/utils/dateUuid';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';

describe('date note hierarchy', () => {
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

  it('creates year, month, and day pages with correct hierarchy', async () => {
    const store = await makeStore();
    const daily = getOrCreateDailyNote(store, '2024-07-30');

    const expectedYearUuid = yearToYearUuid(2024);
    const expectedMonthUuid = yearMonthToMonthUuid(2024, 7);
    const expectedDayUuid = dateStrToDayUuid('2024-07-30');

    expect(daily.uuid).toBe(expectedDayUuid);
    expect(daily.parent_uuid).toBe(expectedMonthUuid);

    const monthly = store.getNode(expectedMonthUuid);
    expect(monthly).toBeDefined();
    expect(monthly?.parentId).toBe(expectedYearUuid);
    expect(monthly?.classIds).toContain(SYSTEM_CLASS_UUIDS.month);

    const yearly = store.getNode(expectedYearUuid);
    expect(yearly).toBeDefined();
    expect(yearly?.parentId).toBeNull();
    expect(yearly?.classIds).toContain(SYSTEM_CLASS_UUIDS.year);
  });

  it('repairs an orphaned daily page to point to its monthly parent', async () => {
    const store = await makeStore();
    const dayUuid = dateStrToDayUuid('2024-07-30');

    // Create an orphaned daily page (no parent) like legacy code did.
    store.createNode({ nodeId: dayUuid, kind: 'page', parentId: null, classIds: [SYSTEM_CLASS_UUIDS.day] });
    store.setNodeText(dayUuid, '2024-07-30');

    const daily = getOrCreateDailyNote(store, '2024-07-30');
    const expectedMonthUuid = yearMonthToMonthUuid(2024, 7);
    expect(daily.parent_uuid).toBe(expectedMonthUuid);
  });

  it('creates monthly page under yearly parent', async () => {
    const store = await makeStore();
    const monthly = getOrCreateMonthlyNote(store, 2024, 7);

    expect(monthly.parent_uuid).toBe(yearToYearUuid(2024));
    expect(monthly.name).toBe('20240700');
  });

  it('creates yearly page at root', async () => {
    const store = await makeStore();
    const yearly = getOrCreateYearlyNote(store, 2024);

    expect(yearly.parent_uuid).toBeNull();
    expect(yearly.name).toBe('20240000');
  });
});
