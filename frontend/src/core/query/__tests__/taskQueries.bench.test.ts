/**
 * Performance regression benchmark for the daily-page task sections.
 *
 * A daily page renders "Scheduled Tasks" and "Overdue Tasks" sections whose
 * ASTs (buildScheduledForDayQueryAST / buildOverdueQueryAST) combine a class
 * condition with several custom property conditions. The compiler used to emit
 * per-row correlated EXISTS subqueries against property_value; it now emits
 * decorrelated IN subqueries (see generatePropertyCondition in
 * compileToSqlite.ts). This test seeds ~10k nodes, times both forms, and
 * asserts identical results.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createTestDatabase } from '../../__tests__/helpers';
import { compileToSqlite } from '../compileToSqlite';
import { queryAll } from '../../db/sqlite';
import { uuidv7 } from '../../uuid';
import type { QueryAST } from '@/types/queryAST';
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import { buildOverdueQueryAST, buildScheduledForDayQueryAST } from '@/utils/taskQueries';
import { dateToDayUuid, getTodayDayUuid } from '@/utils/dateUuid';
import { toLegacyPropertySql } from './legacyPropertySql';

const NODE_COUNT = 10_000;
const TASK_COUNT = 400;

// Generous ceiling: ~3x the worst observed time under full-suite load
// (~30ms). Measured at ~7ms isolated for both the compiled IN form and the
// legacy correlated EXISTS form on this dataset — the query is dominated by
// the workspace scan, not the property subqueries (see task report).
const MAX_QUERY_MS = 100;

const STATUSES = ['Pending', 'Doing', 'Done', 'Cancelled'];
const OPEN_STATUSES = new Set(['Pending', 'Doing']);

interface SeedResult {
  overdueIds: string[];
  scheduledTodayIds: string[];
}

function dayOffset(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return dateToDayUuid(d);
}

describe('task section query benchmark (property conditions)', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  async function seed(): Promise<{ db: Awaited<ReturnType<typeof createTestDatabase>>; workspaceId: string; expected: SeedResult }> {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();

    db.run('INSERT INTO class_hierarchy (class_id, ancestor_id) VALUES (?, ?)', [
      SYSTEM_CLASS_UUIDS.task,
      SYSTEM_CLASS_UUIDS.task,
    ]);

    const insertNode = (id: string, classIds: string[]): void => {
      db.run(
        `INSERT INTO node (id, workspace_id, kind, class_ids, parent_id, content, text_content, active, created_at, updated_at)
         VALUES (?, ?, 'block', ?, NULL, '[]', NULL, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        [id, workspaceId, JSON.stringify(classIds)]
      );
    };
    const insertProp = (nodeId: string, schemaId: string, value: unknown): void => {
      db.run(
        'INSERT INTO property_value (id, node_id, property_schema_id, value, idx) VALUES (?, ?, ?, ?, 0)',
        [uuidv7(), nodeId, schemaId, JSON.stringify(value)]
      );
    };

    const expected: SeedResult = { overdueIds: [], scheduledTodayIds: [] };

    db.exec('BEGIN TRANSACTION');
    try {
      for (let i = 0; i < NODE_COUNT; i++) {
        insertNode(uuidv7(), []);
      }
      for (let i = 0; i < TASK_COUNT; i++) {
        const id = uuidv7();
        insertNode(id, [SYSTEM_CLASS_UUIDS.task]);
        const status = STATUSES[i % STATUSES.length];
        insertProp(id, SYSTEM_PROPERTY_UUIDS.task_status, status);
        // 1/4 unscheduled; the rest spread across overdue/today/future.
        if (i % 4 === 3) continue;
        const offset = i % 3 === 0 ? -(1 + (i % 30)) : i % 3 === 1 ? 0 : 1 + (i % 30);
        insertProp(id, SYSTEM_PROPERTY_UUIDS.task_scheduled, dayOffset(offset));
        if (!OPEN_STATUSES.has(status)) continue;
        if (offset < 0) expected.overdueIds.push(id);
        if (offset === 0) expected.scheduledTodayIds.push(id);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    expected.overdueIds.sort();
    expected.scheduledTodayIds.sort();
    return { db, workspaceId, expected };
  }

  function runBoth(
    db: Awaited<ReturnType<typeof createTestDatabase>>,
    ast: QueryAST,
    workspaceId: string
  ): { ids: string[]; legacyIds: string[]; ms: number; legacyMs: number } {
    const compiled = compileToSqlite(ast, workspaceId);

    const start = performance.now();
    const rows = queryAll<{ id: string }>(db, compiled.sql, compiled.params as never);
    const ms = performance.now() - start;

    const legacySql = toLegacyPropertySql(compiled.sql);
    const legacyStart = performance.now();
    const legacyRows = queryAll<{ id: string }>(db, legacySql, compiled.params as never);
    const legacyMs = performance.now() - legacyStart;

    return {
      ids: rows.map((r) => r.id),
      legacyIds: legacyRows.map((r) => r.id),
      ms,
      legacyMs,
    };
  }

  it(`runs the overdue + scheduled-for-day ASTs over ${NODE_COUNT} nodes quickly`, async () => {
    const { db, workspaceId, expected } = await seed();
    const todayUuid = getTodayDayUuid();

    const overdue = runBoth(db, buildOverdueQueryAST(), workspaceId);
    const scheduled = runBoth(db, buildScheduledForDayQueryAST(todayUuid), workspaceId);

    console.log(
      `[bench] overdue: compiled=${overdue.ms.toFixed(1)}ms legacy_exists=${overdue.legacyMs.toFixed(1)}ms ` +
        `(rows=${overdue.ids.length})`
    );
    console.log(
      `[bench] scheduled_for_day: compiled=${scheduled.ms.toFixed(1)}ms legacy_exists=${scheduled.legacyMs.toFixed(1)}ms ` +
        `(rows=${scheduled.ids.length})`
    );

    // Correctness: compiled form matches the legacy form and the JS-computed expectation.
    expect(overdue.ids).toEqual(overdue.legacyIds);
    expect(scheduled.ids).toEqual(scheduled.legacyIds);
    expect(overdue.ids).toEqual(expected.overdueIds);
    expect(scheduled.ids).toEqual(expected.scheduledTodayIds);
    expect(overdue.ids.length).toBeGreaterThan(0);
    expect(scheduled.ids.length).toBeGreaterThan(0);

    expect(overdue.ms).toBeLessThan(MAX_QUERY_MS);
    expect(scheduled.ms).toBeLessThan(MAX_QUERY_MS);
  }, 60_000);
});
